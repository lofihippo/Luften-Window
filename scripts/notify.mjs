#!/usr/bin/env node
// Multi-channel notification dispatcher. Uses fetch only, no dependencies.
// Each channel is enabled by the presence of its environment variables.
// One channel failing should not stop the others or fail the job.

const TIMEOUT_MS = 10000;

async function post(url, options, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: String(err.message || err) };
  }
}

/** Send to ntfy. */
async function ntfy({ title, body, tags }, { env, fetchImpl }) {
  const topic = env.NTFY_TOPIC;
  if (!topic) return { ok: false, skipped: true };
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  const headers = {};
  if (title) headers.Title = title;
  if (tags) headers.Tags = tags;
  return post(`${server.replace(/\/$/, "")}/${topic}`, { method: "POST", headers, body }, fetchImpl);
}

/** Send plain + simple HTML email via the Resend HTTP API. */
async function resend({ title, body }, { env, fetchImpl }) {
  const key = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  const to = env.EMAIL_TO;
  if (!key || !from || !to) return { ok: false, skipped: true };
  const res = await post("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map((s) => s.trim()),
      subject: title,
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`,
    }),
  }, fetchImpl);
  return res;
}

/** Send to a Discord webhook. */
async function discord({ body }, { env, fetchImpl }) {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true };
  return post(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: body }),
  }, fetchImpl);
}

/** Send to a Telegram chat. */
async function telegram({ title, body }, { env, fetchImpl }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true };
  const text = title ? `${title}\n${body}` : body;
  return post(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }, fetchImpl);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send a notification to every configured channel, or only selected channels
 * when retrying an event with partial prior delivery.
 * @param {object} m { title, body, tags }
 * @param {object} options Optional environment, HTTP transport, and logger overrides.
 * @returns {Promise<Array<{channel, ok, error?, skipped?}>>}
 */
export async function send({ title, body, tags }, { env = process.env, fetchImpl = fetch, logger = console,
  channels: selected } = {}) {
  const dependencies = { env, fetchImpl };
  const channels = [
    ["ntfy", () => ntfy({ title, body, tags }, dependencies)],
    ["email", () => resend({ title, body }, dependencies)],
    ["discord", () => discord({ body }, dependencies)],
    ["telegram", () => telegram({ title, body }, dependencies)],
  ];
  if (selected !== undefined && (!Array.isArray(selected)
      || selected.some((name) => !channels.some(([channel]) => channel === name)))) {
    throw new Error("Unknown notification channel selection");
  }
  const results = [];
  for (const [name, fn] of channels) {
    if (selected !== undefined && !selected.includes(name)) continue;
    try {
      const r = await fn();
      results.push({ channel: name, ...r });
      if (r.ok) logger.log(`notify[${name}]: sent`);
      else if (!r.skipped) logger.log(`notify[${name}]: ${r.error || "failed"}`);
      else logger.log(`notify[${name}]: skipped (not configured)`);
    } catch (err) {
      results.push({ channel: name, ok: false, error: String(err.message || err) });
      logger.log(`notify[${name}]: ERROR ${err.message || err}`);
    }
  }
  return results;
}

// Backwards-compatible single-ntfy helper (used by the M6 code path/tests).
export async function sendNtfy({ title, body, tags, topic, server = "https://ntfy.sh" }, { fetchImpl = fetch } = {}) {
  if (!topic) return { ok: false, error: "no topic" };
  const headers = {};
  if (title) headers.Title = title;
  if (tags) headers.Tags = tags;
  return post(`${server.replace(/\/$/, "")}/${topic}`, { method: "POST", headers, body }, fetchImpl);
}
