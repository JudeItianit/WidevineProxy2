function detectManifestType(text) {
  const lower = text.toLowerCase();
  if (lower.includes("<mpd") && lower.includes("</mpd>")) {
    return "DASH";
  }
  if (lower.includes("#extm3u")) {
    return lower.includes("#ext-x-stream-inf") ? "HLS_MASTER" : "HLS_PLAYLIST";
  }
  if (
    lower.includes("<smoothstreamingmedia")
    && lower.includes("</smoothstreamingmedia>")
  ) {
    return "MSS";
  }
  return undefined;
}

function typeFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".mpd")) {
    return "DASH";
  }
  if (lower.includes(".m3u8")) {
    return "HLS_MASTER";
  }
  if (lower.includes(".ism/manifest") || lower.endsWith("/manifest")) {
    return "MSS";
  }
  return undefined;
}

function typeFromContentType(contentType) {
  const lower = contentType.toLowerCase();
  if (lower.includes("dash+xml")) {
    return "DASH";
  }
  if (lower.includes("mpegurl")) {
    return "HLS_MASTER";
  }
  if (lower.includes("smoothstreaming")) {
    return "MSS";
  }
  return undefined;
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Manifest body read timed out")), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function manifestPublicFields(manifest) {
  return {
    fileName: manifest.url,
    fingerprint: createHash("sha256").update(manifest.url).digest("hex").slice(0, 16),
    host: manifest.host,
    httpOk: manifest.ok,
    status: manifest.status,
    type: manifest.type,
  };
}

export class ManifestTracker {
  constructor({ captureBody = false, maxBodyBytes = 2_000_000, onCapture } = {}) {
    this.captureBody = captureBody;
    this.maxBodyBytes = maxBodyBytes;
    this.onCapture = onCapture;
    this.manifests = new Map();
    this.pending = new Set();
  }

  track(response) {
    const task = this.inspect(response).catch(() => {});
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }

  async inspect(response) {
    const url = response.url();
    const urlType = typeFromUrl(url);
    if (urlType) {
      await this.record(urlType, response);
      return;
    }

    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    const headerType = typeFromContentType(contentType);
    if (headerType) {
      await this.record(headerType, response);
      return;
    }

    const request = response.request();
    if (request.method() !== "GET" || !["xhr", "fetch", "other"].includes(request.resourceType())) {
      return;
    }

    const contentLength = Number(headers["content-length"] || 0);
    if (contentLength > this.maxBodyBytes) {
      return;
    }
    if (/^(audio|video|image|font)\//i.test(contentType)) {
      return;
    }

    const text = await withTimeout(response.text(), 5_000);
    if (Buffer.byteLength(text, "utf8") > this.maxBodyBytes) {
      return;
    }
    const detected = detectManifestType(text);
    if (detected) {
      await this.record(detected, response, text);
    }
  }

  async record(type, response, bodyText) {
    const url = response.url();
    const key = `${type}:${url}`;
    if (this.manifests.has(key)) {
      return;
    }
    const parsed = new URL(url);
    const manifest = {
      host: parsed.host,
      ok: response.ok(),
      status: response.status(),
      type,
      url,
    };
    if (this.captureBody) {
      try {
        const body = bodyText ?? (await withTimeout(response.text(), 5_000));
        if (body && Buffer.byteLength(body, "utf8") <= this.maxBodyBytes) {
          manifest.body = body;
        }
      } catch {
        // Body capture is best-effort; ignore failures.
      }
    }
    this.manifests.set(key, manifest);
    this.onCapture?.(manifest);
  }

  async flush() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  getMpdUrl() {
    return this.getDash()?.url;
  }

  getDash() {
    const dashManifests = [...this.manifests.values()]
      .filter(({ type }) => type === "DASH");
    return dashManifests.findLast(({ ok }) => ok) || dashManifests.at(-1);
  }

  getDashHistory() {
    return [...this.manifests.values()]
      .filter(({ type }) => type === "DASH")
      .map(manifestPublicFields);
  }

  getAll() {
    return [...this.manifests.values()];
  }
}
import { createHash } from "node:crypto";
