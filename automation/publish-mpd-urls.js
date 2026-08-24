/**
 * publish-mpd-urls.js
 *
 * Reads the latest channel-health report (artifacts/channel-health.json) and
 * publishes each healthy channel's live MPD URL to a Cloudflare KV namespace.
 * sky-nz-worker then 307-redirects /<slug>.mpd to that URL (see the sky-nz-worker
 * project). Decoupled from the monitor on purpose: run it on a schedule (cron /
 * supervisor post-step) or chain it right after `npm run monitor`.
 *
 * Required env (server secrets — never commit):
 *   CF_API_TOKEN      Cloudflare API token with KV write (Account > Workers KV)
 *   CF_ACCOUNT_ID     Cloudflare account id
 *   KV_NAMESPACE_ID   the MPD_URLS namespace id (from `wrangler kv namespace create`)
 *
 * Optional env:
 *   HEALTH_REPORT_PATH  override report location (defaults to artifacts/channel-health.json)
 *   CHANNEL_SLUG_MAP    JSON {"SKY SPORT 1 NZ":"skysport1nz", ...} to force slug mapping
 *   MPD_PUBLISH_STATUSES  comma list of statuses to publish (default: healthy)
 *
 * Safe to run when creds are missing: it logs and exits 0 so a cron job won't
 * page you. It never throws on a single channel failure.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPORT_PATH = "artifacts/channel-health.json";

/** Lower-case + strip non-alphanumerics: "SKY SPORT 1 NZ" -> "skysport1nz". */
export function slugifyChannel(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function resolveSlugMap() {
  const raw = process.env.CHANNEL_SLUG_MAP?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    console.warn("[publish-mpd-urls] CHANNEL_SLUG_MAP is not valid JSON; ignoring.");
    return null;
  }
}

function channelSlug(channel, slugMap) {
  if (slugMap && channel.channel in slugMap) {
    return slugMap[channel.channel];
  }
  return slugifyChannel(channel.channel);
}

async function readReport(reportPath) {
  const file = await readFile(reportPath, "utf8");
  return JSON.parse(file);
}

async function putMpdUrl({ accountId, apiToken, namespaceId, slug, url }) {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/storage/kv/namespaces/${namespaceId}/values/${slug}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, fetchedAt: Date.now() }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CF KV PUT ${response.status} for ${slug}: ${text.slice(0, 200)}`);
  }
}

/** Publish every eligible channel in a report to KV. Returns a summary. */
export async function publishReportToKv(report, env = process.env) {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();
  const namespaceId = env.KV_NAMESPACE_ID?.trim();

  if (!accountId || !apiToken || !namespaceId) {
    return {
      skipped: true,
      reason:
        "CF_API_TOKEN / CF_ACCOUNT_ID / KV_NAMESPACE_ID not set; skipping KV publish.",
    };
  }

  const channels = Array.isArray(report?.channels) ? report.channels : [];
  const allowed = new Set(
    (env.MPD_PUBLISH_STATUSES || "healthy")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const slugMap = resolveSlugMap();

  const results = [];
  for (const channel of channels) {
    const mpdUrl = channel?.manifest?.fileName;
    if (!mpdUrl) continue;
    if (!allowed.has(channel.status)) continue;
    const slug = channelSlug(channel, slugMap);
    try {
      await putMpdUrl({ accountId, apiToken, namespaceId, slug, url: mpdUrl });
      results.push({ slug, url: mpdUrl, ok: true });
    } catch (error) {
      results.push({ slug, url: mpdUrl, ok: false, error: String(error.message || error) });
    }
  }

  const published = results.filter((r) => r.ok).length;
  const failed = results.length - published;
  return { skipped: false, published, failed, results };
}

async function main() {
  const reportPath = path.resolve(
    process.env.HEALTH_REPORT_PATH?.trim() || DEFAULT_REPORT_PATH,
  );
  console.log(`[publish-mpd-urls] Reading report: ${reportPath}`);

  let report;
  try {
    report = await readReport(reportPath);
  } catch (error) {
    console.error(`[publish-mpd-urls] Could not read report: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const summary = await publishReportToKv(report);
  if (summary.skipped) {
    console.log(`[publish-mpd-urls] ${summary.reason}`);
    return;
  }
  console.log(
    `[publish-mpd-urls] Published ${summary.published}, failed ${summary.failed}.`,
  );
  for (const r of summary.results) {
    if (!r.ok) console.warn(`  FAIL ${r.slug}: ${r.error}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}

// Run when invoked directly (not when imported by another module).
// fileURLToPath keeps the path comparison correct on Windows.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  await main();
}
