// Playlist (HLS / m3u8) capture logic for the channel-playlist worker.
// Unlike channel-health (which waits for DASH playback), this worker only needs
// the first playlist.m3u8 response to come back with HTTP 200.

// Strict mode (default): matches the well-known /playlist.m3u8 (HLS) response
// while explicitly excluding DASH manifests.
const PLAYLIST_M3U8_PATTERN = /\/playlist\.m3u8(\?|$)/i;

// Loose mode (iframe embeds, PLAYLIST_MATCH_MODE=any): matches ANY url ending in
// .m3u8 (HLS master or variant playlist) while excluding DASH manifests. Used by
// the 2-hour iframe capture where the stream url looks like
// https://<host>/main/secure/<hash>/<ts>/<slug>.m3u8.
const ANY_M3U8_PATTERN = /\.m3u8(\?|$)/i;

export function isPlaylistM3u8(url, matchMode = "playlist") {
  if (!url || /\.mpd(\?|$)/i.test(url)) {
    return false;
  }
  const pattern = matchMode === "any" ? ANY_M3U8_PATTERN : PLAYLIST_M3U8_PATTERN;
  return pattern.test(url);
}

// Resolves with the first m3u8 response observed on the page (per config.matchMode),
// or null after playlistCaptureTimeoutMs. The response listener is always detached.
function waitForPlaylistM3u8(page, config, log) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const onResponse = (response) => {
      if (settled) {
        return;
      }
      const url = response.url();
      if (isPlaylistM3u8(url, config.matchMode)) {
        settled = true;
        clearTimeout(timer);
        page.off("response", onResponse);
        let host;
        try {
          host = new URL(url).host;
        } catch {
          host = undefined;
        }
        log.info(`Observed m3u8 playlist from ${host} (HTTP ${response.status()}).`);
        resolve({ url, status: response.status() });
      }
    };
    page.on("response", onResponse);
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      page.off("response", onResponse);
      resolve(null);
    }, config.playlistCaptureTimeoutMs);
  });
}

export async function probeChannel(page, target, config, log) {
  const startedAt = Date.now();
  const label = config.matchMode === "any" ? "m3u8" : "playlist.m3u8";
  let playlistUrl = null;
  let playlistHost = null;
  let lastStatus = null;
  let refreshes = 0;

  // Initial load + up to playlistMaxRetries refreshes.
  const maxAttempts = config.playlistMaxRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const navigation = attempt === 1
      ? page.goto(target.url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs })
      : page.reload({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    const captured = await waitForPlaylistM3u8(page, config, log);
    await navigation.catch(() => {});

    if (captured && captured.status === 200) {
      playlistUrl = captured.url;
      try {
        playlistHost = new URL(captured.url).host;
      } catch {
        playlistHost = null;
      }
      lastStatus = 200;
      break;
    }

    lastStatus = captured?.status ?? null;
    if (attempt < maxAttempts) {
      refreshes += 1;
      log.warn(
        `${target.slug}: ${label} returned ${lastStatus ?? "no response"} `
        + `(attempt ${attempt}/${config.playlistMaxRetries}); refreshing.`,
      );
      // The reload for the next attempt happens at the top of the loop.
    }
  }

  const healthy = playlistUrl !== null && lastStatus === 200;
  return {
    slug: target.slug,
    url: target.url,
    playlistUrl,
    playlistHost,
    httpStatus: lastStatus,
    status: healthy ? "healthy" : "failed",
    checkedAt: new Date().toISOString(),
    retriesUsed: refreshes,
    summary: healthy
      ? undefined
      : lastStatus === null
        ? `No ${label} response observed before the capture timeout`
        : `${label} returned HTTP ${lastStatus} after ${refreshes} refresh(es)`,
    errors: [],
  };
}

export function buildReport({ results, startedAt, targets, maxRetries }) {
  const channels = results;
  const counts = Object.fromEntries(
    ["healthy", "failed"].map((status) => [
      status,
      channels.filter((channel) => channel.status === status).length,
    ]),
  );

  return {
    channels,
    generatedAt: new Date().toISOString(),
    scope: {
      maxRetries,
      mode: "playlist-m3u8-capture",
      targetCount: targets.length,
    },
    summary: {
      durationMs: Date.now() - startedAt,
      ...counts,
      total: channels.length,
    },
  };
}

export function formatSummary(report) {
  const channels = report?.channels || [];
  const healthy = channels.filter(({ status }) => status === "healthy");
  const failed = channels.filter(({ status }) => status === "failed");
  const line = (label, entries) =>
    `${label} (${entries.length}): ${entries.map(({ slug }) => slug).join(", ") || "none"}`;

  return [
    "Playlist capture summary:",
    line("Healthy", healthy),
    line("Failed", failed),
  ];
}
