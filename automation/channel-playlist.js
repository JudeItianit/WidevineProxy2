// Playlist (HLS / m3u8) capture logic for the channel-playlist worker.
// Unlike channel-health (which waits for DASH playback), this worker only needs
// the first playlist.m3u8 response to come back with HTTP 200.

// Matches a playlist.m3u8 (HLS) response while explicitly excluding DASH manifests.
const M3U8_PATTERN = /\/playlist\.m3u8(\?|$)/i;

export function isPlaylistM3u8(url) {
  if (!url || /\.mpd(\?|$)/i.test(url)) {
    return false;
  }
  return M3U8_PATTERN.test(url);
}

// Resolves with the first playlist.m3u8 response observed on the page, or null
// after playlistCaptureTimeoutMs. The response listener is always detached.
function waitForPlaylistM3u8(page, config, log) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const onResponse = (response) => {
      if (settled) {
        return;
      }
      const url = response.url();
      if (isPlaylistM3u8(url)) {
        settled = true;
        clearTimeout(timer);
        page.off("response", onResponse);
        let host;
        try {
          host = new URL(url).host;
        } catch {
          host = undefined;
        }
        log.info(`Observed playlist.m3u8 from ${host} (HTTP ${response.status()}).`);
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
        `${target.slug}: playlist.m3u8 returned ${lastStatus ?? "no response"} `
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
        ? "No playlist.m3u8 response observed before the capture timeout"
        : `playlist.m3u8 returned HTTP ${lastStatus} after ${refreshes} refresh(es)`,
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
