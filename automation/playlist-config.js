import fs from "node:fs";
import path from "node:path";

const envFilePath = path.resolve(process.env.ENV_FILE?.trim() || ".env");
if (fs.existsSync(envFilePath)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Loading .env files requires Node.js 20.12 or newer");
  }
  process.loadEnvFile(envFilePath);
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

function parseJson(name, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

function loadTargets() {
  const raw = process.env.PLAYLIST_TARGETS?.trim();
  if (!raw) {
    return [];
  }
  const parsed = parseJson("PLAYLIST_TARGETS", raw);
  if (!Array.isArray(parsed)) {
    throw new Error("PLAYLIST_TARGETS must be a JSON array of {slug,url} objects");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`PLAYLIST_TARGETS[${index}] must be an object`);
    }
    const slug = String(entry.slug ?? "").trim();
    const url = String(entry.url ?? "").trim();
    if (!slug) {
      throw new Error(`PLAYLIST_TARGETS[${index}] is missing a "slug"`);
    }
    try {
      // Validate it is an absolute http(s) URL.
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("not http(s)");
      }
    } catch {
      throw new Error(`PLAYLIST_TARGETS[${index}] has an invalid "url": ${url}`);
    }
    return { slug, url };
  });
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
    return parseJson("PLAYLIST_STORAGE_STATE_PATH", fs.readFileSync(filePath, "utf8"));
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
  const configuredChannel = process.env.BROWSER_CHANNEL?.trim() || "chrome";
  const browserChannel = ["none", "bundled"].includes(configuredChannel.toLowerCase())
    ? undefined
    : configuredChannel;

  return {
    browserChannel,
    browserFallback: booleanValue("BROWSER_FALLBACK", true),
    extraHTTPHeaders: loadExtraHeaders(),
    failOnUnhealthy: booleanValue("FAIL_ON_UNHEALTHY", false),
    // HEADLESS toggle: "false" => headed; "true" (default) => old headless (no Widevine
    // CDM); "new" => new headless (exposes the Widevine CDM for Widevine-only services).
    headlessMode: process.env.HEADLESS?.trim().toLowerCase() || "true",
    ignoreHTTPSErrors: booleanValue("IGNORE_HTTPS_ERRORS", false),
    navigationTimeoutMs: positiveInteger("NAVIGATION_TIMEOUT_MS", 60_000),
    playlistCaptureTimeoutMs: positiveInteger("PLAYLIST_CAPTURE_TIMEOUT_MS", 30_000),
    playlistMaxRetries: positiveInteger("PLAYLIST_MAX_RETRIES", 20),
    postTimeoutMs: positiveInteger("POST_TIMEOUT_MS", 30_000),
    reportEndpoint: process.env.HEALTH_REPORT_ENDPOINT?.trim() || undefined,
    reportPath: path.resolve(
      process.env.HEALTH_REPORT_PATH?.trim() || "artifacts/channel-playlist.json",
    ),
    reportToken: process.env.HEALTH_REPORT_TOKEN?.trim() || undefined,
    storageState: loadStorageState(),
    targets: loadTargets(),
  };
}
