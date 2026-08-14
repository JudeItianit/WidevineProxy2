import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import {
  buildReport,
  discoverSkyGoCards,
  formatChannelResultSummary,
  inspectCardForTargets,
} from "./automation/channel-health.js";
import { loadConfig } from "./automation/config.js";
import { installDrmObserver } from "./automation/drm-observer.js";
import { createKeyExtractor } from "./automation/key-extractor.js";
import { installKeyExtractionHook } from "./automation/key-extraction-hook.js";

chromium.use(StealthPlugin());

const log = {
  error(message) {
    console.error(`[health] ERROR: ${message}`);
  },
  info(message) {
    console.log(`[health] ${message}`);
  },
  warn(message) {
    console.warn(`[health] WARNING: ${message}`);
  },
};

function publicErrorMessage(error) {
  return String(error?.message || error)
    .replace(/\s+/g, " ")
    .trim()
}

async function launchBrowser(config) {
  const mode = config.headlessMode || "true";
  const headless = mode !== "false";
  const options = {
    args: ["--autoplay-policy=no-user-gesture-required"],
    headless,
  };
  // New headless exposes the Widevine CDM (old headless does not), which is required
  // for services that serve Widevine instead of a ClearKey fallback.
  if (mode === "new") {
    options.args.push("--headless=new");
  }

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
    throw new Error(`Health report endpoint returned HTTP ${response.status}`);
  }
  await response.arrayBuffer();
  log.info("Health report delivered to the configured endpoint.");
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new Error("Node.js 20 or newer is required");
  }

  const config = loadConfig();
  const startedAt = Date.now();
  const results = [];
  let cardsScanned = 0;
  let browser;
  let context;
  let fatalError;

  try {
    browser = await launchBrowser(config);
    context = await browser.newContext({
      extraHTTPHeaders: config.extraHTTPHeaders,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      storageState: config.storageState,
    });
    await context.addInitScript(installDrmObserver);
    const page = await context.newPage();

    if (config.extractKeys) {
      if (!config.widevineDeviceB64) {
        throw new Error(
          "EXTRACT_KEYS is enabled but WIDEVINE_DEVICE_B64 is not set. "
          + "Add the base64 of your .wvd file as a secret.",
        );
      }
      const extractor = createKeyExtractor({ deviceB64: config.widevineDeviceB64 });
      log.info(`Key extraction enabled using local WVD device: ${extractor.deviceName}`);
      await context.addInitScript(installKeyExtractionHook);
      await page.exposeFunction("__wvdCreateChallenge", extractor.createChallenge);
      await page.exposeFunction("__wvdParseLicense", extractor.parseLicense);
    }

    const cards = await discoverSkyGoCards(page, config, log);

    for (const card of cards) {
      const completed = new Set(results.map(({ channel }) => channel));
      const remaining = config.targetChannels.filter((name) => !completed.has(name));
      if (remaining.length === 0) {
        log.info("All target channels have been checked; ending the crawl.");
        break;
      }

      cardsScanned += 1;
      log.info(`Checking SKY GO watch page ${cardsScanned}/${cards.length}.`);
      const { result } = await inspectCardForTargets(
        page,
        card,
        remaining,
        config,
        log,
      );
      if (result?.channel && !completed.has(result.channel)) {
        results.push(result);
        log.info(`${result.channel}: ${result.status}.`);
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
    cardsScanned,
    playerMode: config.playerMode,
    results,
    startedAt,
    targetChannels: config.targetChannels,
    targetUrl: config.targetUrl,
  });
  if (fatalError) {
    report.fatalError = publicErrorMessage(fatalError);
  }
  await fs.mkdir(path.dirname(config.reportPath), { recursive: true });
  await fs.writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log.info(`Health report written to ${config.reportPath}.`);
  for (const line of formatChannelResultSummary(report)) {
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
