import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReport,
  determineChannelStatus,
  discoveryIsStable,
  isBenignRequestFailure,
  isDrmRelatedText,
  isIgnoredRequestNoise,
  normalizeName,
  sameChannel,
  shouldUsePlayFallback,
} from "./channel-health.js";
import { collectDrmLifecycle } from "./drm-observer.js";
import { ManifestTracker } from "./manifest-tracker.js";

test("channel names are normalized without confusing numbered ESPN channels", () => {
  assert.equal(normalizeName(" Sky-Sport 7 (NZ) "), "SKY SPORT 7 NZ");
  assert.equal(sameChannel("ESPN", "ESPN NZ"), true);
  assert.equal(sameChannel("ESPN 2 NZ", "ESPN NZ"), false);
  assert.equal(sameChannel("SKY SPORT 9 NZ", "SKY SPORT 9 NZ"), true);
});

test("empty card discovery is never accepted as stable", () => {
  assert.equal(discoveryIsStable(0, 20, 3), false);
  assert.equal(discoveryIsStable(64, 2, 3), false);
  assert.equal(discoveryIsStable(64, 3, 3), true);
});

test("ad failures are ignored and ordinary element errors are not labeled as DRM", () => {
  assert.equal(isIgnoredRequestNoise("https://adsco.re:2087/t"), true);
  assert.equal(isIgnoredRequestNoise("chrome-extension://example/script.js"), true);
  assert.equal(isIgnoredRequestNoise("https://media.example/manifest.mpd"), false);
  assert.equal(isDrmRelatedText("element is not stable"), false);
  assert.equal(isDrmRelatedText("Widevine license request failed"), true);
  assert.equal(isBenignRequestFailure("net::ERR_ABORTED"), true);
  assert.equal(isBenignRequestFailure("net::ERR_CONNECTION_RESET"), false);
});

test("the optional Play control is only useful when the source click produced no signal", () => {
  assert.equal(shouldUsePlayFallback(false, undefined), true);
  assert.equal(shouldUsePlayFallback(true, undefined), false);
  assert.equal(shouldUsePlayFallback(false, { type: "DASH" }), false);
});

test("confirmed playback stays healthy with either configured player", () => {
  const dash = { ok: true, status: 200, type: "DASH" };
  assert.equal(determineChannelStatus({
    dash,
    playerReady: true,
    playbackInitialized: true,
    sourceSelected: true,
  }), "healthy");
  assert.equal(determineChannelStatus({
    dash,
    playerReady: true,
    playbackInitialized: false,
    sourceSelected: true,
  }), "degraded");
  assert.equal(determineChannelStatus({
    dash: undefined,
    playerReady: true,
    playbackInitialized: true,
    sourceSelected: true,
  }), "failed");
});

test("a successful DASH response is preferred over its redirect", async () => {
  const tracker = new ManifestTracker();
  const response = (status, suffix) => ({
    headers: () => ({}),
    ok: () => status >= 200 && status < 300,
    request: () => ({
      method: () => "GET",
      resourceType: () => "document",
    }),
    status: () => status,
    url: () => `https://media.example/${suffix}/manifest.mpd`,
  });

  tracker.track(response(301, "redirect"));
  tracker.track(response(200, "final"));
  await tracker.flush();

  assert.equal(tracker.getDash().status, 200);
  assert.equal(tracker.getDashHistory().length, 2);
  assert.equal("url" in tracker.getDashHistory()[0], false);
  assert.equal(
    tracker.getDashHistory()[1].fileName,
    "https://media.example/final/manifest.mpd",
  );
});

test("passive DRM lifecycle counters merge without retaining license data", async () => {
  const states = [
    {
      generateRequestCalls: 1,
      keySystemAccessGranted: 1,
      keySystemAccessRequests: 1,
      keySystems: ["com.widevine.alpha"],
      licenseUpdateAttempts: 1,
      licenseUpdatesApplied: 1,
      mediaKeysAttached: 1,
      sessionsCreated: 1,
    },
    {
      generateRequestCalls: 0,
      keySystemAccessGranted: 0,
      keySystemAccessRequests: 1,
      keySystems: ["com.widevine.alpha"],
      licenseUpdateAttempts: 0,
      licenseUpdatesApplied: 0,
      mediaKeysAttached: 0,
      sessionsCreated: 0,
    },
  ];
  const page = {
    frames: () => states.map((state) => ({
      evaluate: async () => state,
    })),
  };

  const result = await collectDrmLifecycle(page);
  assert.deepEqual(result.keySystems, ["com.widevine.alpha"]);
  assert.equal(result.keySystemAccessRequests, 2);
  assert.equal(result.licenseUpdatesApplied, 1);
  assert.equal("keys" in result, false);
  assert.equal("license" in result, false);
});

test("health reports add missing targets and include the MPD URL used for syncing", () => {
  const report = buildReport({
    cardsScanned: 4,
    results: [{
      channel: "ESPN NZ",
      manifest: {
        available: true,
        fileName: "https://media.example/live/manifest.mpd?token=example",
        host: "media.example",
        httpOk: true,
        status: 200,
        type: "DASH",
      },
      status: "healthy",
    }],
    startedAt: Date.now(),
    targetChannels: ["ESPN NZ", "ESPN 2 NZ"],
    targetUrl: "https://streamninja.cloud/",
  });

  assert.equal(report.summary.healthy, 1);
  assert.equal(report.summary.not_found, 1);
  assert.equal(report.scope.manifestUrlsIncluded, true);
  assert.equal(
    report.channels[0].manifest.fileName,
    "https://media.example/live/manifest.mpd?token=example",
  );
});
