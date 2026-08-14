import fs from "node:fs";
import path from "node:path";

const envFilePath = path.resolve(process.env.ENV_FILE?.trim() || ".env");
if (fs.existsSync(envFilePath)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Loading .env files requires Node.js 20.12 or newer");
  }
  process.loadEnvFile(envFilePath);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function booleanValue(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be true or false`);
  }
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function webUrl(name, value, allowInsecure = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (!allowInsecure && parsed.protocol !== "https:") {
    throw new Error(`${name} must use https (or explicitly enable its insecure override)`);
  }
  return parsed.toString();
}

function optionalWebUrl(name, allowInsecure = false) {
  const value = process.env[name]?.trim();
  return value ? webUrl(name, value, allowInsecure) : undefined;
}

function parseJson(name, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

function csvValues(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one comma-separated value`);
  }
  return values;
}

function enumValue(name, allowed, fallback) {
  const value = process.env[name]?.trim().toLowerCase() || fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function loadStorageState() {
  const encoded = process.env.PLAYWRIGHT_STORAGE_STATE_BASE64?.trim();
  const filePath = process.env.PLAYWRIGHT_STORAGE_STATE_PATH?.trim();

  if (encoded && filePath) {
    throw new Error(
      "Set only one of PLAYWRIGHT_STORAGE_STATE_BASE64 and PLAYWRIGHT_STORAGE_STATE_PATH",
    );
  }

  if (encoded) {
    return parseJson(
      "PLAYWRIGHT_STORAGE_STATE_BASE64",
      Buffer.from(encoded, "base64").toString("utf8"),
    );
  }
  if (filePath) {
    return parseJson(
      "PLAYWRIGHT_STORAGE_STATE_PATH",
      fs.readFileSync(filePath, "utf8"),
    );
  }
  return undefined;
}

function loadExtraHeaders() {
  const raw = process.env.EXTRA_HTTP_HEADERS_JSON?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = parseJson("EXTRA_HTTP_HEADERS_JSON", raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("EXTRA_HTTP_HEADERS_JSON must contain a JSON object");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [name, String(value)]),
  );
}

export function loadConfig() {
  const allowInsecureTarget = booleanValue("ALLOW_INSECURE_TARGET", false);
  const allowInsecureReport = booleanValue("ALLOW_INSECURE_REPORT_ENDPOINT", false);
  const targetUrl = webUrl(
    "TARGET_STREAM_URL",
    process.env.TARGET_STREAM_URL?.trim() || "https://streamninja.cloud/",
    allowInsecureTarget,
  );

  const configuredChannel = process.env.BROWSER_CHANNEL?.trim() || "chrome";
  const browserChannel = ["none", "bundled"].includes(configuredChannel.toLowerCase())
    ? undefined
    : configuredChannel;

  return {
    browserChannel,
    browserFallback: booleanValue("BROWSER_FALLBACK", true),
    channelTimeoutMs: positiveInteger("CHANNEL_TIMEOUT_MS", 90_000),
    discoveryMaxPasses: positiveInteger("DISCOVERY_MAX_PASSES", 40),
    discoveryRetries: positiveInteger("DISCOVERY_RETRIES", 3),
    discoveryScrollDelayMs: positiveInteger("DISCOVERY_SCROLL_DELAY_MS", 500),
    discoveryStablePasses: positiveInteger("DISCOVERY_STABLE_PASSES", 3),
    extraHTTPHeaders: loadExtraHeaders(),
    failOnUnhealthy: booleanValue("FAIL_ON_UNHEALTHY", false),
    headless: booleanValue("HEADLESS", true),
    ignoreHTTPSErrors: booleanValue("IGNORE_HTTPS_ERRORS", false),
    navigationTimeoutMs: positiveInteger("NAVIGATION_TIMEOUT_MS", 60_000),
    maxCards: positiveInteger("MAX_CARDS", 200),
    playerMode: enumValue("PLAYER_MODE", ["default", "shaka"], "default"),
    playFallbackDelayMs: positiveInteger("PLAY_FALLBACK_DELAY_MS", 30_000),
    playFallbackEnabled: booleanValue("PLAY_FALLBACK_ENABLED", false),
    postTimeoutMs: positiveInteger("POST_TIMEOUT_MS", 30_000),
    reportEndpoint: optionalWebUrl("HEALTH_REPORT_ENDPOINT", allowInsecureReport),
    reportPath: path.resolve(
      process.env.HEALTH_REPORT_PATH?.trim() || "artifacts/channel-health.json",
    ),
    reportToken: process.env.HEALTH_REPORT_TOKEN?.trim() || undefined,
    sourceSettleMs: nonNegativeInteger("SOURCE_SETTLE_MS", 1_000),
    storageState: loadStorageState(),
    // Key extraction (opt-in). When enabled the monitor MITMs the EME exchange
    // with your local .wvd device to recover content keys. This is the same
    // mechanism the browser extension uses; it intentionally re-signs the
    // challenge, so video playback in the headless browser will usually not
    // decrypt -- the goal is key capture, not playback. WIDEVINE_DEVICE_B64 is
    // the base64 of your .wvd file (kept in a secret, never committed).
    extractKeys: booleanValue("EXTRACT_KEYS", false),
    widevineDeviceB64: process.env.WIDEVINE_DEVICE_B64?.trim() || undefined,
    // Capture the raw manifest body alongside the URL/status. Needed to surface
    // the MPD + PSSH in the report; also implied by extractKeys.
    captureManifestBody: booleanValue("CAPTURE_MANIFEST_BODY", false) || booleanValue("EXTRACT_KEYS", false),
    targetChannels: csvValues("TARGET_CHANNELS", [
      "ESPN NZ",
      "ESPN 2 NZ",
      "SKY SPORT 1 NZ",
      "SKY SPORT 2 NZ",
      "SKY SPORT 3 NZ",
      "SKY SPORT 4 NZ",
      "SKY SPORT 5 NZ",
      "SKY SPORT 6 NZ",
      "SKY SPORT 7 NZ",
      "SKY SPORT 8 NZ",
      "SKY SPORT 9 NZ",
      "SKY SPORT SELECT NZ",
    ]),
    targetUrl,
  };
}
