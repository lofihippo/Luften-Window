#!/usr/bin/env node
// Checker job: fetch forecast, evaluate windows, write data/state files,
// and (optionally) send notifications.

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchForecast } from "../public/core/forecast.js";
import { planForecast } from "../public/core/windows.js";
import { buildCalendar } from "../public/core/calendar.js";
import { cToF } from "../public/core/psychro.js";
import { validate } from "../public/core/settings.js";
import { send } from "./notify.mjs";
import { runCheckerLoop } from "./check-loop.mjs";
import { localDateKey, zonedParts, tomorrowAtHour, formatLocalTime } from "../public/core/zoned-time.js";
import { deliveryNamespace, configuredChannels, normalizeDeliveryState,
  pendingChannels, recordDeliveryResults } from "./delivery-state.mjs";
import { publishArtifacts } from "./publication.mjs";

const CONFIG_PATH = fileURLToPath(new URL("../public/config.json", import.meta.url));
const PUBLIC_ROOT = fileURLToPath(new URL("../public", import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL("../public/data/windows.json", import.meta.url));
const DEFAULT_STATE = fileURLToPath(new URL("../.state/state.json", import.meta.url));

function insidePath(path, root) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot));
}

// Resolve existing path ancestors before comparing locations. The final file
// or one of its parent directories may be a symlink into the served tree.
function canonicalPath(path) {
  const missing = [];
  let ancestor = path;
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...missing.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function checkerPaths({ output, stateFile, env, canonicalize }) {
  const checkedPath = (value, label) => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error(`Invalid checker ${label} path`);
    }
    return resolve(value);
  };
  const out = checkedPath(output ?? env.OW_OUTPUT ?? DEFAULT_OUTPUT, "output");
  if (!out.endsWith(".json")) throw new Error("Checker output path must end in .json");
  const icsPath = checkedPath(env.OW_ICS ?? `${out.slice(0, -5)}.ics`, "calendar");
  const checkStatusPath = checkedPath(env.OW_CHECK_STATUS ?? join(dirname(out), "check-status.json"), "check status");
  const statePath = checkedPath(stateFile ?? env.OW_STATE ?? DEFAULT_STATE, "state");
  if (new Set([out, icsPath, checkStatusPath, statePath]).size !== 4) {
    throw new Error("Checker paths for forecast JSON, calendar, check status, and private state must be distinct");
  }
  const actual = canonicalize
    ? [out, icsPath, checkStatusPath, statePath].map(canonicalPath)
    : [out, icsPath, checkStatusPath, statePath];
  if (new Set(actual).size !== 4) {
    throw new Error("Checker paths for forecast JSON, calendar, check status, and private state must be distinct");
  }
  if (insidePath(actual[3], dirname(actual[0]))
      || insidePath(actual[3], canonicalize ? canonicalPath(PUBLIC_ROOT) : PUBLIC_ROOT)) {
    throw new Error("Checker state path must be outside the public output directory");
  }
  return { out, icsPath, checkStatusPath, statePath };
}

// ----- Real fs implementation (surfaced so tests can swap) -----
const realFs = {
  readFile: (p) => readFile(p, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  }),
  writeFile: (p, content) => writeFile(p, content),
  rename,
  unlink,
  mkdir,
};

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function applyEnv(settings, env) {
  const out = { ...settings };
  const numeric = (value) => {
    // An explicitly blank override is invalid, never an absent value or zero.
    const text = typeof value === "string" ? value.trim() : "";
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
  };
  if (Object.hasOwn(env, "OW_LAT")) out.location = { ...out.location, lat: numeric(env.OW_LAT) };
  if (Object.hasOwn(env, "OW_LON")) out.location = { ...out.location, lon: numeric(env.OW_LON) };
  const fields = {
    OW_INDOOR_C: "indoorTempC", OW_TARGET_RH: "targetRH", OW_SURFACE_C: "coldestSurfaceC",
    OW_MARGIN_C: "marginC", OW_DAYS: "forecastDays",
  };
  for (const [key, field] of Object.entries(fields)) {
    if (Object.hasOwn(env, key)) out[field] = numeric(env[key]);
  }
  return out;
}

function lastRunDate(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function compactHours(evaluated) {
  return evaluated.map((h) => ({
    t: h.t,
    tempC: h.tempC,
    dewPointC: h.dewPointC,
    rh: h.rh,
    precipProb: h.precipProb,
    precipMm: h.precipMm,
    windKmh: h.windKmh,
    ok: h.ok,
    reasons: h.reasons,
    predictedIndoorRH: h.predictedIndoorRH,
  }));
}

// The countdown is recomputed by the browser; it is not a new published
// forecast until the underlying hour/window decision changes.
function sameContent(a, b) {
  const strip = (o) => {
    const c = { ...o, status: o.status ? { ...o.status } : o.status };
    delete c.generatedAt;
    if (c.status) delete c.status.remainingSeconds;
    return c;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function sameCalendarExceptStamp(a, b) {
  const strip = (text) => text.replace(/^DTSTAMP:\d{8}T\d{6}Z\r\n/gm, "DTSTAMP:<publication>\r\n");
  return strip(a) === strip(b);
}

function tempStr(c, settings) {
  if (c == null) return "n/a";
  return settings.units === "F" ? `${Math.round(cToF(c))}°F` : `${Math.round(c)}°C`;
}

async function deliver({ stateObj, event, message, identities, notifyImpl, persistState }) {
  const pending = pendingChannels(stateObj, event, identities);
  if (pending.length === 0) return false;
  const requested = Object.fromEntries(pending.map((name) => [name, identities[name]]));
  let changed;
  try {
    const results = await notifyImpl(message, { channels: pending });
    changed = recordDeliveryResults(stateObj, event, requested, results);
  } catch (err) {
    console.error(`notify error: ${err.message || err}`);
    return false;
  }
  // Persist each confirmed event before attempting another. A crash between
  // remote acceptance and this write still requires provider idempotency.
  if (changed) await persistState();
  return changed;
}

async function maybeNotify({ settings, now, win, stateObj, notifyImpl, timezone, identities, persistState }) {
  const n = settings.notify || {};
  if (!n.enabled) return;
  const lead = (n.leadHours ?? 1) * 3600;

  // Realtime alerts only when notify.realtime is true (Section 13).
  if (n.realtime) {
    const target = win.find((w) => {
      const dt = w.start - now;
      return dt <= lead && dt > -3600;
    });
    if (target) {
      await deliver({ stateObj, event: `open:${target.start}`, identities, notifyImpl, persistState,
        message: {
          title: "Open the windows",
          body: `OK from ${formatLocalTime(target.start, timezone)} to ${formatLocalTime(target.end, timezone)} (lowest forecast dew point ${tempStr(target.minDewC, settings)})`,
          tags: "window,droplet",
        } });
    }

    const current = win.find((w) => now >= w.start && now < w.end);
    if (current) {
      const until = current.end - now;
      if (until <= lead && until > 0) {
        await deliver({ stateObj, event: `close:${current.start}:${current.end}`, identities, notifyImpl, persistState,
          message: {
            title: "Close the windows",
            body: `The humidity window closes at ${formatLocalTime(current.end, timezone)}.`,
            tags: "window",
          } });
      }
    }
  }

  // Daily digest (Section 13).
  await maybeDigest({ settings, now, win, stateObj, notifyImpl, timezone, identities, persistState });
}

async function maybeDigest({ settings, now, win, stateObj, notifyImpl, timezone, identities, persistState }) {
  const digest = settings.notify?.digest;
  if (!digest || !digest.enabled) return;
  const tz = timezone || "UTC";
  const todayLocal = localDateKey(now, tz);
  const hourLocal = zonedParts(now, tz).hour;
  if (hourLocal < (digest.hourLocal ?? 7)) return;

  const cutoff = tomorrowAtHour(now, tz, 9);
  const candidates = win.filter((w) => w.end > now && w.start < cutoff);
  let message;
  if (candidates.length === 0) {
    const next = win.find((w) => w.start >= cutoff);
    message = next
      ? `No suitable window before ${formatLocalTime(cutoff, tz)}. Next: ${formatLocalTime(next.start, tz)}.`
      : `No suitable window before ${formatLocalTime(cutoff, tz)}. No further window forecast.`;
  } else {
    message = candidates
      .map((w) => `${formatLocalTime(w.start, tz)}–${formatLocalTime(w.end, tz)} (lowest forecast dew point ${tempStr(w.minDewC, settings)})`)
      .join("; ");
  }
  await deliver({ stateObj, event: `digest:${todayLocal}`, identities, notifyImpl, persistState,
    message: { title: "OpenWindow daily digest", body: message, tags: "window" } });
}

/**
 * Run one checker pass.
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] injected forecast fetch
 * @param {number}  [deps.now] current unix seconds
 * @param {object}  [deps.fs] { readFile, writeFile, rename, unlink, mkdir? }
 * @param {object}  [deps.config] config object, defaults to public/config.json
 * @param {object}  [deps.env] environment overrides, defaults to process.env
 * @param {Function} [deps.notifyImpl] injected send({...})
 * @param {string}  [deps.output] output file path
 * @param {string}  [deps.stateFile] state file path
 */
export async function run({
  fetchImpl,
  now,
  fs,
  config = loadConfig(),
  env = process.env,
  notifyImpl = (message, { channels }) => send(message, { env, channels }),
  output,
  stateFile,
} = {}) {
  const settings = applyEnv(config, env);
  const checked = validate(settings);
  if (!checked.ok) throw new Error(`Invalid checker settings: ${checked.errors.join("; ")}`);
  const nowS = now != null ? now : Math.floor(Date.now() / 1000);
  const dateStr = lastRunDate(nowS);
  const { out, icsPath, checkStatusPath, statePath } = checkerPaths({
    output, stateFile, env, canonicalize: !fs,
  });

  // An injected filesystem must never fall through to real disk operations.
  const f = fs || realFs;

  // Fetch the forecast (allow test injection).
  const fetched = await (fetchImpl ? fetchForecast(settings, fetchImpl) : fetchForecast(settings));
  if (!fetched || !fetched.hours) {
    throw new Error("Forecast fetch failed: no hours returned");
  }

  const { evaluated: ev, windows: win, status, limitC } = planForecast(fetched.hours, settings, nowS);
  if (!ev.some((hour) => !hour.reasons.includes("NO_DATA"))) {
    throw new Error("Forecast has no usable current or future hours");
  }

  const newData = {
    generatedAt: new Date(nowS * 1000).toISOString(),
    lastRunDate: dateStr,
    location: settings.location,
    timezone: fetched.timezone,
    limitC,
    status,
    windows: win,
    hours: compactHours(ev),
    // Preserve the normalized observations, including pre-now history. The
    // browser must re-plan these with its own settings and current time.
    forecastHours: fetched.hours,
  };

  // Prepare the complete publication before changing either final file. A
  // countdown-only change does not republish JSON; the browser recalculates it.
  const prevRaw = await f.readFile(out);
  let prevObj = null;
  if (prevRaw) {
    try { prevObj = JSON.parse(prevRaw); } catch { prevObj = null; }
  }
  const oldStamp = typeof prevObj?.generatedAt === "string" ? Date.parse(prevObj.generatedAt) : NaN;
  const sameJson = prevObj && prevObj.lastRunDate === dateStr && Number.isFinite(oldStamp)
    && sameContent(prevObj, newData);
  const oldIcs = await f.readFile(icsPath);
  const candidateIcs = buildCalendar({ settings, windows: win, timezone: fetched.timezone, stampEpoch: nowS });
  const sameIcs = typeof oldIcs === "string" && sameCalendarExceptStamp(oldIcs, candidateIcs);
  const jsonContent = sameJson && sameIcs ? prevRaw : JSON.stringify(newData, null, 2) + "\n";
  const icsContent = sameIcs ? oldIcs : candidateIcs;
  const publishedGeneratedAt = sameJson && sameIcs ? prevObj.generatedAt : newData.generatedAt;
  const checkStatusContent = JSON.stringify({ checkedAt: newData.generatedAt,
    generatedAt: publishedGeneratedAt }, null, 2) + "\n";
  // Stage all three files together. The tiny marker is renamed last, so a
  // failed marker write/rename rolls back any forecast or calendar replacement.
  const publication = await publishArtifacts({ fs: f, commitLastPath: checkStatusPath, artifacts: [
    { path: icsPath, content: icsContent },
    { path: out, content: jsonContent },
    { path: checkStatusPath, content: checkStatusContent },
  ] });
  if (publication.cleanupErrors?.length) {
    console.error(`check: published, but temporary-file cleanup failed: ${publication.cleanupErrors[0].message}`);
  }

  // State + notifications.
  const stateRaw = await f.readFile(statePath);
  let parsedState = null;
  if (stateRaw) {
    try { parsedState = JSON.parse(stateRaw); } catch { parsedState = null; }
  }
  const stateObj = normalizeDeliveryState(parsedState, deliveryNamespace(settings, fetched.timezone));
  const identities = configuredChannels(env);
  stateObj.lastCheckedAt = new Date(nowS * 1000).toISOString();
  const persistState = () => publishArtifacts({ fs: f, artifacts: [
    { path: statePath, content: JSON.stringify(stateObj, null, 2) + "\n" },
  ] });
  await maybeNotify({ settings, now: nowS, win, stateObj, notifyImpl, timezone: fetched.timezone,
    identities, persistState });
  await persistState();

  return { changed: publication.published.includes(icsPath) || publication.published.includes(out),
    data: { ...newData, generatedAt: publishedGeneratedAt } };
}

// ----- CLI -----
async function cli() {
  const args = process.argv.slice(2);
  const loop = args.includes("--loop");
  const execute = async () => {
    const { changed } = await run({});
    console.log(`check: ${changed ? "updated" : "unchanged"} at ${new Date().toISOString()}`);
  };

  if (!loop) {
    try { await execute(); } catch (err) {
      console.error(`check: ERROR ${err.message || err}`);
      process.exitCode = 1;
    }
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runCheckerLoop({ run: execute, intervalMin: process.env.OW_INTERVAL_MIN ?? 30,
      signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) cli().catch((err) => {
  console.error(`check: ERROR ${err.message || err}`);
  process.exitCode = 1;
});
