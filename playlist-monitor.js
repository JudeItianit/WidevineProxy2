import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { buildReport, formatSummary, probeChannel } from "./automation/channel-playlist.js";
import { loadConfig } from "./automation/playlist-config.js";

chromium.use(StealthPlugin());

const log = {
  error(message) {
    console.error(`[playlist] ERROR: ${message}`);
  },
  info(message) {
    console.log(`[playlist] ${message}`);
  },
  warn(message) {
    console.warn(`[playlist] WARNING: ${message}`);
  },
};

function publicErrorMessage(error) {
  return String(error?.message || error)
    .replace(/\s+/g, " ")
    .trim();
}

async function launchBrowser(config) {
  const options = {
    args: ["--autoplay-policy=no-user-gesture-required"],
    headless: config.headless,
  };

  if (!config.browserChannel) {
    return chromium.launch(options);
  }

  try {
    return await chromium.launch({ ...options, channel: config.browserChannel });
  } catch (error) {
    if (!config.browserFallback) {
      throw error;
    }
    log.warn(
      `Could not launch "${config.browserChannel}" (${error.message}); `
      + "using Playwright Chromium.",
    );
    return chromium.launch(options);
  }
}

async function postReport(report, config) {
  if (!config.reportEndpoint) {
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (config.reportToken) {
    headers.Authorization = `Bearer ${config.reportToken}`;
  }
  const response = await fetch(config.reportEndpoint, {
    body: JSON.stringify(report),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(config.postTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Playlist report endpoint returned HTTP ${response.status}`);
  }
  await response.arrayBuffer();
  log.info("Playlist report delivered to the configured endpoint.");
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new Error("Node.js 20 or newer is required");
  }

  const config = loadConfig();
  if (config.targets.length === 0) {
    throw new Error(
      "No PLAYLIST_TARGETS configured. Set the PLAYLIST_TARGETS repository variable "
      + "to a JSON array of {slug,url} objects.",
    );
  }

  const startedAt = Date.now();
  const results = [];
  let browser;
  let context;
  let fatalError;

  try {
    browser = await launchBrowser(config);
    // One browser + one context (preserves storage state / cookies across channels).
    context = await browser.newContext({
      extraHTTPHeaders: config.extraHTTPHeaders,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      storageState: config.storageState,
    });

    for (const target of config.targets) {
      const page = await context.newPage();
      try {
        log.info(`Scanning ${target.slug} -> ${target.url}`);
        const result = await probeChannel(page, target, config, log);
        results.push(result);
        log.info(`${target.slug}: ${result.status} (HTTP ${result.httpStatus ?? "n/a"}).`);
      } catch (error) {
        results.push({
          slug: target.slug,
          url: target.url,
          playlistUrl: null,
          playlistHost: null,
          httpStatus: null,
          status: "failed",
          checkedAt: new Date().toISOString(),
          retriesUsed: 0,
          summary: publicErrorMessage(error),
          errors: [{ kind: "monitor", message: publicErrorMessage(error), material: true }],
        });
        log.error(`${target.slug}: ${error.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error(String(error));
    log.error(fatalError.message);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  const report = buildReport({
    maxRetries: config.playlistMaxRetries,
    results,
    startedAt,
    targets: config.targets,
  });
  if (fatalError) {
    report.fatalError = publicErrorMessage(fatalError);
  }
  await fs.mkdir(path.dirname(config.reportPath), { recursive: true });
  await fs.writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log.info(`Playlist report written to ${config.reportPath}.`);
  for (const line of formatSummary(report)) {
    log.info(line);
  }
  await postReport(report, config);

  const unhealthy = report.channels.some(({ status }) => status !== "healthy");
  if (fatalError || (unhealthy && config.failOnUnhealthy)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  if (process.env.DEBUG?.trim().toLowerCase() === "true" && error?.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
