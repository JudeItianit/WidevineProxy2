import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { ManifestTracker } from "./manifest-tracker.js";
import { collectDrmLifecycle } from "./drm-observer.js";

const TARGET_ALIASES = new Map([
  ["ESPN NZ", new Set(["ESPN", "ESPN NZ"])],
]);

export function isDrmRelatedText(value) {
  return /\b(?:drm|widevine|eme|license|key system)\b/i.test(String(value));
}

export function isIgnoredRequestNoise(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome-extension:"
      || parsed.hostname === "adsco.re"
      || parsed.hostname.endsWith(".adsco.re");
  } catch {
    return false;
  }
}

export function isBenignRequestFailure(errorText) {
  return String(errorText).trim().toUpperCase() === "NET::ERR_ABORTED";
}

// Pull base64 PSSH boxes out of a DASH manifest body. Matches both the
// namespaced <cenc:pssh> and the bare <pssh> variants; returns them as an array
// of base64 strings (one per ContentProtection entry).
export function extractPsshFromMpd(body) {
  if (!body) {
    return [];
  }
  const matches = body.match(/<(?:cenc:)?pssh>([^<]+)<\/(?:cenc:)?pssh>/gi) || [];
  const pssh = [];
  for (const tag of matches) {
    const inner = tag.replace(/<[^>]+>/g, "").trim();
    if (inner) {
      pssh.push(inner);
    }
  }
  return pssh;
}

// Read whatever the in-page key-extraction hook accumulated on the page.
async function collectExtractedKeys(page) {
  const aggregate = { errors: [], keys: [], pssh: [], challengeCalls: 0, licenseCalls: 0, createSkippedNoFn: 0, clearKeyChallengeCalls: 0, clearKeyLicenseCalls: 0, hookActive: false, diag: {} };
  for (const frame of page.frames()) {
    const data = await frame.evaluate(() => {
      const current = globalThis.__channelHealthKeys;
      return current
        ? {
            errors: [...current.errors],
            keys: [...current.keys],
            pssh: [...current.pssh],
            challengeCalls: current.challengeCalls || 0,
            licenseCalls: current.licenseCalls || 0,
            createSkippedNoFn: current.createSkippedNoFn || 0,
            clearKeyChallengeCalls: current.clearKeyChallengeCalls || 0,
            clearKeyLicenseCalls: current.clearKeyLicenseCalls || 0,
            hookActive: Boolean(current.hookActive),
            diag: current.diag || {},
          }
        : null;
    }).catch(() => null);
    if (!data) {
      continue;
    }
    aggregate.errors.push(...data.errors);
    aggregate.keys.push(...data.keys);
    aggregate.pssh.push(...data.pssh);
    aggregate.challengeCalls += data.challengeCalls;
    aggregate.licenseCalls += data.licenseCalls;
    aggregate.createSkippedNoFn += data.createSkippedNoFn;
    aggregate.clearKeyChallengeCalls += data.clearKeyChallengeCalls;
    aggregate.clearKeyLicenseCalls += data.clearKeyLicenseCalls;
    aggregate.hookActive = aggregate.hookActive || data.hookActive;
    if (data.diag) {
      // Null-skipping merge: an un-exercised frame returns diag fields as null
      // (it never saw a challenge/license). A plain Object.assign would clobber
      // the real values collected from the exercising frame with those nulls.
      for (const [key, value] of Object.entries(data.diag)) {
        if (value != null) {
          aggregate.diag[key] = value;
        }
      }
    }
  }
  return aggregate;
}

export function normalizeName(value) {
  return String(value)
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function shortText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

export function sameChannel(actual, target) {
  const normalizedActual = normalizeName(actual);
  const normalizedTarget = normalizeName(target);
  const aliases = TARGET_ALIASES.get(normalizedTarget);
  return normalizedActual === normalizedTarget || aliases?.has(normalizedActual) || false;
}

function publicPageId(url) {
  const parsed = new URL(url);
  return createHash("sha256").update(parsed.pathname).digest("hex").slice(0, 12);
}

async function resilientClick(locator, timeoutMs = 5_000) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: timeoutMs });
    return "pointer";
  } catch (pointerError) {
    try {
      await locator.evaluate((node) => {
        const clickable = node.closest(
          'button, [role="button"], [role="menuitem"], [role="option"]',
        ) || node;
        clickable.click();
      });
      return "dom";
    } catch {
      throw pointerError;
    }
  }
}

async function clickVisible(locators, timeoutMs = 5_000) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        await resilientClick(candidate, timeoutMs);
        return true;
      }
    }
  }
  return false;
}

export function discoveryIsStable(cardCount, stablePasses, requiredStablePasses) {
  return cardCount > 0 && stablePasses >= requiredStablePasses;
}

export async function discoverSkyGoCards(page, config, log) {
  const cards = new Map();

  for (let attempt = 1; attempt <= config.discoveryRetries; attempt += 1) {
    await page.goto(config.targetUrl, {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    const toggle = page.getByRole("button", { name: /toggle sky go/i }).first();
    const hasToggle = (await toggle.count().catch(() => 0)) > 0;
    if (hasToggle) {
      await toggle.waitFor({ state: "visible", timeout: config.navigationTimeoutMs });
      await toggle.scrollIntoViewIfNeeded();
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await resilientClick(toggle, 3_000);
      }
    }

    const section = hasToggle
      ? page.locator("section").filter({
          has: page.getByRole("button", { name: /toggle sky go/i }),
        }).first()
      : page.locator("body");
    let stablePasses = 0;
    let previousCount = -1;

    for (
      let pass = 0;
      pass < config.discoveryMaxPasses && cards.size < config.maxCards;
      pass += 1
    ) {
      const found = await page.locator('a[href*="/stream/skygo/"]').evaluateAll((links) => (
        links.map((link) => ({
          href: link.href,
          label: [
            link.querySelector("h3")?.textContent,
            link.querySelector("img")?.alt,
            ...[...link.querySelectorAll("p")].map((node) => node.textContent),
          ].filter(Boolean).join(" | "),
        }))
      ));

      for (const card of found) {
        cards.set(card.href, card);
      }

      stablePasses = cards.size > 0 && cards.size === previousCount
        ? stablePasses + 1
        : 0;
      previousCount = cards.size;
      if (discoveryIsStable(cards.size, stablePasses, config.discoveryStablePasses)) {
        break;
      }

      if (pass % 4 === 0) {
        await section.evaluate((node) => node.scrollIntoView({ block: "end" }));
      } else {
        await page.mouse.wheel(0, 900);
      }
      await delay(config.discoveryScrollDelayMs);
    }

    if (cards.size > 0) {
      break;
    }
    log.warn(
      `SKY GO cards did not populate on home-page attempt `
      + `${attempt}/${config.discoveryRetries}; retrying.`,
    );
  }

  const result = [...cards.values()].slice(0, config.maxCards);
  if (result.length === 0) {
    throw new Error(
      `The SKY GO section loaded, but no watch-page cards appeared after `
      + `${config.discoveryRetries} attempt(s)`,
    );
  }
  log.info(`Discovered ${result.length} unique SKY GO watch page(s).`);
  return result;
}

class ProbeDiagnostics {
  constructor(page, config, log) {
    this.page = page;
    this.log = log;
    this.config = config;
    this.errors = [];
    this.manifests = new ManifestTracker({
      // The report no longer includes the manifest body; the decryptor (backend)
      // fetches the MPD itself. captureBody stays available (default false) for
      // any future need without wiring it into the report.
      captureBody: false,
      onCapture: ({ host, status, type }) => {
        log.info(`Observed ${type} manifest from ${host} (HTTP ${status}).`);
      },
    });

    this.onConsole = (message) => {
      const drmRelated = isDrmRelatedText(message.text());
      if (message.type() === "error" || drmRelated) {
        this.record("console", message.text(), drmRelated);
      }
    };
    this.onPageError = (error) => this.record("page", error.message, true);
    this.onRequestFailed = (request) => {
      if (isIgnoredRequestNoise(request.url())) {
        return;
      }
      if (
        ["document", "xhr", "fetch", "media"].includes(request.resourceType())
        || /drm|widevine|eme|license|manifest|\.mpd/i.test(request.url())
      ) {
        const errorText = request.failure()?.errorText || "request failed";
        this.record(
          "request",
          `${errorText}: ${request.url()}`,
          !isBenignRequestFailure(errorText),
        );
      }
    };
    this.onResponse = (response) => {
      if (isIgnoredRequestNoise(response.url())) {
        return;
      }
      this.manifests.track(response);
      if (response.status() >= 400) {
        const request = response.request();
        if (
          ["document", "xhr", "fetch", "media"].includes(request.resourceType())
          || /drm|widevine|eme|license|manifest|\.mpd/i.test(response.url())
        ) {
          this.record("http", `HTTP ${response.status()}: ${response.url()}`, true);
        }
      }
    };
  }

  start() {
    this.page.on("console", this.onConsole);
    this.page.on("pageerror", this.onPageError);
    this.page.on("requestfailed", this.onRequestFailed);
    this.page.on("response", this.onResponse);
  }

  async stop() {
    this.page.off("console", this.onConsole);
    this.page.off("pageerror", this.onPageError);
    this.page.off("requestfailed", this.onRequestFailed);
    this.page.off("response", this.onResponse);
    await this.manifests.flush();
  }

  record(kind, message, material = false) {
    const clean = shortText(message);
    if (!clean || this.errors.some((error) => error.kind === kind && error.message === clean)) {
      return;
    }
    if (this.errors.length < 25) {
      this.errors.push({
        drmRelated: isDrmRelatedText(clean),
        kind,
        material,
        message: clean,
      });
    }
  }
}

function playerButtonLocator(page) {
  return page.getByRole("button").filter({
    has: page.getByText("Player", { exact: true }),
  }).first();
}

async function readActivePlayer(page) {
  const playerButton = playerButtonLocator(page);
  await playerButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const label = await playerButton.locator("span.text-zinc-200").textContent().catch(() => "");
  return label?.replace(/\s+/g, " ").trim() || undefined;
}

async function selectShaka(page, log) {
  const playerButton = playerButtonLocator(page);
  await playerButton.waitFor({ state: "visible", timeout: 15_000 });
  const clickMethod = await resilientClick(playerButton, 5_000);
  if (clickMethod === "dom") {
    log.warn("The Player control was overlay-blocked; used a DOM click fallback.");
  }

  const selected = await clickVisible([
    page.getByRole("menuitem", { name: /^shaka(?: player)?$/i }),
    page.getByRole("option", { name: /^shaka(?: player)?$/i }),
    page.getByRole("button", { name: /^shaka(?: player)?$/i }),
    page.getByText(/^shaka(?: player)?$/i),
  ]);
  return selected;
}

async function preparePlayer(page, config, log) {
  const before = await readActivePlayer(page);
  if (config.playerMode === "default") {
    log.info(`Using the current site player${before ? ` (${before})` : ""}.`);
    return {
      active: before || null,
      changed: false,
      ready: true,
      requested: "Site default",
      selected: true,
    };
  }

  log.info("Selecting the Shaka player.");
  const selected = await selectShaka(page, log);
  if (config.sourceSettleMs > 0) {
    await delay(config.sourceSettleMs);
  }
  const active = await readActivePlayer(page);
  return {
    active: active || null,
    changed: true,
    ready: selected,
    requested: "Shaka",
    selected,
  };
}

async function readSourceLabels(page) {
  const labels = page.locator(".stream-source-btn span.min-w-0.truncate");
  await labels.first().waitFor({
    state: "visible",
    timeout: 15_000,
  }).catch(() => {});

  return labels.evaluateAll((spans) => (
    spans.map((span) => span.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean)
  ));
}

async function selectSource(page, targetName, log) {
  const labels = page.locator(".stream-source-btn span.min-w-0.truncate");
  const count = await labels.count();
  for (let index = 0; index < count; index += 1) {
    const labelSpan = labels.nth(index);
    const label = await labelSpan.textContent().catch(() => "");
    if (sameChannel(label, targetName)) {
      await labelSpan.scrollIntoViewIfNeeded();
      const clickMethod = await resilientClick(labelSpan, 3_000);
      if (clickMethod === "dom") {
        log.warn(`The ${targetName} source control was overlay-blocked; used a DOM click fallback.`);
      }
      return label.replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

async function requestPlaybackFallback(page) {
  const playClicked = await clickVisible([
    page.getByRole("button", { name: /^play$/i }),
    page.locator('button[aria-label*="play" i]'),
  ]).catch(() => false);

  let videoCount = 0;
  for (const frame of page.frames()) {
    videoCount += await frame.evaluate(async () => {
      const videos = [...document.querySelectorAll("video")];
      await Promise.allSettled(videos.map(async (video) => {
        video.muted = true;
        await video.play();
      }));
      return videos.length;
    }).catch(() => 0);
  }
  return { playClicked, videoCount };
}

async function playbackSnapshot(page) {
  const snapshots = [];
  for (const frame of page.frames()) {
    const frameSnapshots = await frame.evaluate(() => (
      [...document.querySelectorAll("video")].map((video) => ({
        currentTime: Number(video.currentTime.toFixed(3)),
        ended: video.ended,
        error: video.error ? {
          code: video.error.code,
          message: video.error.message || undefined,
        } : null,
        paused: video.paused,
        readyState: video.readyState,
      }))
    )).catch(() => []);
    snapshots.push(...frameSnapshots);
  }
  return snapshots;
}

async function waitForHealthSignal(page, diagnostics, timeoutMs, options = {}) {
  const {
    extractKeys = false,
    playbackGraceMs = 5_000,
    requirePlayback = false,
  } = options;
  const startedAt = Date.now();
  let dashSeenAt;
  let firstTimes;
  let latest = [];

  while (Date.now() - startedAt < timeoutMs) {
    latest = await playbackSnapshot(page);
    firstTimes ??= latest.map(({ currentTime }) => currentTime);
    const initialized = latest.some((video, index) => (
      !video.ended
      && !video.error
      && video.readyState >= 2
      && (!video.paused || video.currentTime > (firstTimes[index] || 0))
    ));
    const dash = diagnostics.manifests.getDash();

    if (initialized && dash) {
      return { initialized, snapshots: latest };
    }
    if (diagnostics.errors.some(({ drmRelated }) => drmRelated) && dash) {
      return { initialized, snapshots: latest };
    }
    // The manifest is already ours: give playback a short grace period, then stop waiting
    // instead of burning the rest of channelTimeoutMs. Playwright's Firefox cannot decode
    // these streams (Chromium can), so without this the loop stalls after we already have
    // the only thing we came for. Key extraction is the exception — it needs the license
    // round-trip to complete, so it keeps the full budget.
    if (dash && !requirePlayback && !extractKeys) {
      dashSeenAt ??= Date.now();
      if (Date.now() - dashSeenAt >= playbackGraceMs) {
        return { initialized, snapshots: latest };
      }
    }
    await delay(500);
  }

  return {
    initialized: latest.some((video) => !video.error && video.readyState >= 2 && !video.paused),
    snapshots: latest,
  };
}

export function shouldUsePlayFallback(playbackInitialized, dashManifest) {
  return !playbackInitialized && !dashManifest;
}

export function determineChannelStatus({
  dash,
  playerReady,
  playbackInitialized,
  sourceSelected,
  requirePlayback = false,
}) {
  if (!sourceSelected || !dash || !dash.ok) {
    return "failed";
  }
  if (playerReady && playbackInitialized) {
    return "healthy";
  }
  // The monitor's real job is to capture the manifest (dice) URL and confirm it answers
  // HTTP 200 — that URL is what the backend publishes. Playback is a bonus signal, not the
  // goal. NOTE: Chromium DOES play these streams, so on that engine "degraded" was a
  // meaningful "the target site is actually broken" signal; but Playwright's Firefox cannot
  // decode them (same class of problem as HEVC), so gating success on playback there would
  // report a perfectly good manifest as degraded. Default: manifest 200 == healthy.
  // Set requirePlayback (REQUIRE_PLAYBACK=true) to restore the stricter behaviour.
  if (!requirePlayback) {
    return "healthy";
  }
  return "degraded";
}

function manifestReport(manifest, responseChain = []) {
  if (!manifest) {
    return { available: false, responseChain };
  }
  const selected = [...responseChain].reverse().find(({ httpOk }) => httpOk)
    || responseChain.at(-1);
  return {
    available: true,
    fileName: selected?.fileName,
    fingerprint: selected?.fingerprint,
    host: manifest.host,
    httpOk: manifest.ok,
    status: manifest.status,
    type: manifest.type,
  };
}

export async function inspectCardForTargets(page, card, remainingTargets, config, log) {
  const diagnostics = new ProbeDiagnostics(page, config, log);
  diagnostics.start();
  const startedAt = Date.now();
  let target;
  let player = {
    active: null,
    changed: false,
    ready: false,
    requested: config.playerMode === "shaka" ? "Shaka" : "Site default",
    selected: false,
  };
  let sourceLabel;

  try {
    await page.goto(card.href, {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    const sourceLabels = await readSourceLabels(page);
    target = remainingTargets.find((name) => (
      sourceLabels.some((label) => sameChannel(label, name))
    ));
    if (!target) {
      return { sourceLabels };
    }

    log.info(`Found ${target}.`);
    player = await preparePlayer(page, config, log);
    sourceLabel = await selectSource(page, target, log);
    if (sourceLabel) {
      log.info(`${target} source selected; waiting for playback.`);
    }

    const playbackStartedAt = Date.now();
    let playFallbackUsed = false;
    let fallbackVideoElements = 0;
    const initialWaitMs = config.playFallbackEnabled
      ? Math.min(config.playFallbackDelayMs, config.channelTimeoutMs)
      : config.channelTimeoutMs;
    const waitOptions = {
      extractKeys: config.extractKeys,
      playbackGraceMs: config.playbackGraceMs,
      requirePlayback: config.requirePlayback,
    };
    let playback = sourceLabel
      ? await waitForHealthSignal(
        page,
        diagnostics,
        initialWaitMs,
        waitOptions,
      )
      : { initialized: false, snapshots: [] };

    if (
      sourceLabel
      && config.playFallbackEnabled
      && shouldUsePlayFallback(playback.initialized, diagnostics.manifests.getDash())
    ) {
      log.warn(
        `No playback signal followed the ${target} source click; trying the Play control.`,
      );
      const fallback = await requestPlaybackFallback(page);
      playFallbackUsed = fallback.playClicked;
      fallbackVideoElements = fallback.videoCount;
    }

    const remainingTimeoutMs = Math.max(
      0,
      config.channelTimeoutMs - (Date.now() - playbackStartedAt),
    );
    // Only keep waiting if something is genuinely still missing. Previously this waited
    // again whenever playback had not initialized, which re-stalled the whole remaining
    // budget even though the manifest was already captured.
    if (
      sourceLabel
      && remainingTimeoutMs > 0
      && (!diagnostics.manifests.getDash()
        || (config.requirePlayback && !playback.initialized))
    ) {
      playback = await waitForHealthSignal(
        page,
        diagnostics,
        remainingTimeoutMs,
        waitOptions,
      );
    }
    await diagnostics.stop();

    const dash = diagnostics.manifests.getDash();
    const dashHistory = diagnostics.manifests.getDashHistory();
    const mpdBody = dash?.body ?? null;
    const extracted = config.extractKeys ? await collectExtractedKeys(page) : null;
    const drm = await collectDrmLifecycle(page);
    const drmErrors = diagnostics.errors.filter(({ drmRelated }) => drmRelated);
    const status = determineChannelStatus({
      dash,
      playerReady: player.ready,
      playbackInitialized: playback.initialized,
      requirePlayback: config.requirePlayback,
      sourceSelected: Boolean(sourceLabel),
    });

    const extractedKeyCount = extracted?.keys?.length ?? 0;
    const summary = drmErrors.length > 0
      ? `${drmErrors.length} DRM-related error(s) observed`
      // Only a real problem when it actually downgraded the result. On engines that
      // cannot decode the stream (Playwright Firefox) the manifest is still perfectly
      // good, so reporting "did not initialize" next to status=healthy is nonsense.
      : dash && !playback.initialized && status === "degraded"
        ? "DASH manifest available, but video did not initialize before the timeout"
        : extractedKeyCount > 0
          ? `Extracted ${extractedKeyCount} key(s) via local WVD device`
          : undefined;

    return {
      result: {
        channel: target,
        manifest: manifestReport(dash, dashHistory),
        keys: extracted?.keys ?? [],
        sourceLabels,
        status,
        errors: diagnostics.errors,
        summary,
      },
    };
  } catch (error) {
    diagnostics.record("monitor", error.message, true);
    await diagnostics.stop();
    const sourceLabels = await readSourceLabels(page).catch(() => []);
    const mpdBody = diagnostics.manifests.getDash()?.body ?? null;
    const extracted = config.extractKeys ? await collectExtractedKeys(page).catch(() => null) : null;
    const drm = await collectDrmLifecycle(page).catch(() => ({
      generateRequestCalls: 0,
      keySystemAccessGranted: 0,
      keySystemAccessRequests: 0,
      keySystems: [],
      licenseUpdateAttempts: 0,
      licenseUpdatesApplied: 0,
      mediaKeysAttached: 0,
      sessionsCreated: 0,
    }));
    return {
      result: {
        channel: target || remainingTargets.find((targetName) => (
          sourceLabels.some((label) => sameChannel(label, targetName))
        )) || null,
        manifest: manifestReport(
          diagnostics.manifests.getDash(),
          diagnostics.manifests.getDashHistory(),
        ),
        keys: extracted?.keys ?? [],
        source: { label: sourceLabel || null, selected: Boolean(sourceLabel) },
        status: "failed",
        errors: diagnostics.errors,
        summary: shortText(error.message),
      },
      sourceLabels,
    };
  } finally {
    await diagnostics.stop();
  }
}

export function buildReport({
  cardsScanned,
  playerMode = "default",
  results,
  startedAt,
  targetChannels,
  targetUrl,
}) {
  const resultNames = new Set(results.map(({ channel }) => channel).filter(Boolean));
  const missing = targetChannels
    .filter((channel) => !resultNames.has(channel))
    .map((channel) => ({
      channel,
      manifest: { available: false },    
      source: { label: null, selected: false },
      status: "not_found",
      errors: [], 
      summary: "No matching source was found in the discovered SKY GO watch pages",
    }));
  const channels = [...results, ...missing];
  const counts = Object.fromEntries(
    ["healthy", "degraded", "failed", "not_found"].map((status) => [
      status,
      channels.filter((channel) => channel.status === status).length,
    ]),
  );

  return {
    channels,
    generatedAt: new Date().toISOString(),
    scope: {
      manifestUrlsIncluded: true,
      mode: "playback-health-only",
      targetHost: new URL(targetUrl).host,
    },
    summary: {
      cardsScanned,
      durationMs: Date.now() - startedAt,
      ...counts,
      total: channels.length,
    },
  };
}

export function formatChannelResultSummary(report) {
  const channels = report?.channels || [];
  const succeeded = channels.filter(({ status }) => status === "healthy");
  const failed = channels.filter(({ status }) => status === "failed");
  const unavailable = channels.filter(({ manifest, status }) => (
    status !== "failed" && manifest?.available === false
  ));
  const degraded = channels.filter(({ status }) => status === "degraded");

  const line = (label, entries) => {
    const names = entries.map(({ channel }) => channel).filter(Boolean);
    return `${label} (${names.length}): ${names.join(", ") || "none"}`;
  };

  return [
    "Channel result summary:",
    line("Succeeded", succeeded),
    line("Failed - worker or target website issue [status=failed]", failed),
    line(
      "Unavailable - channel does not exist yet [manifest.available=false]",
      unavailable,
    ),
    line("Degraded - manifest found but playback was incomplete", degraded),
  ];
}
