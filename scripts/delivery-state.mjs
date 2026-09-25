// Private checker state for confirmed notification deliveries. The version-1
// aggregate markers were written even after transport failures, so they cannot
// safely be interpreted as proof that any channel received a message.

import { createHash } from "node:crypto";

const VERSION = 2;
const MAX_EVENTS = 100;
const CHANNELS = new Set(["ntfy", "email", "discord", "telegram"]);
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT_KEY = /^(?:open:\d+|close:\d+:\d+|digest:\d{4}-\d{2}-\d{2})$/;

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Identify the forecast calculation to which event starts and local dates
 * belong. Presentation-only location labels and notification schedule options
 * are intentionally omitted. A changed destination is tracked per channel.
 */
export function deliveryNamespace(settings, timezone) {
  const profile = {
    location: [settings.location.lat, settings.location.lon],
    timezone,
    units: settings.units,
    indoorTempC: settings.indoorTempC,
    targetRH: settings.targetRH,
    coldestSurfaceC: settings.coldestSurfaceC,
    marginC: settings.marginC,
    minOutdoorC: settings.minOutdoorC,
    maxOutdoorC: settings.maxOutdoorC,
    maxRainProb: settings.maxRainProb,
    maxWindKmh: settings.maxWindKmh,
    minWindowHours: settings.minWindowHours,
    requireDrying: settings.requireDrying,
    indoorReading: settings.indoorReading == null
      ? null
      : [settings.indoorReading.tempC, settings.indoorReading.rh],
    forecastDays: settings.forecastDays,
  };
  return hash(["openwindow-delivery-namespace-v2", profile]);
}

/**
 * Return only fully configured channels. The hashes change when a destination
 * or credential changes, without writing those values to the state file.
 */
export function configuredChannels(env = {}) {
  const identities = {};
  const present = (value) => typeof value === "string" && value.trim().length > 0;
  if (present(env.NTFY_TOPIC)) {
    identities.ntfy = hash(["ntfy", env.NTFY_SERVER || "https://ntfy.sh", env.NTFY_TOPIC]);
  }
  if (present(env.RESEND_API_KEY) && present(env.EMAIL_FROM) && present(env.EMAIL_TO)) {
    identities.email = hash(["email", env.RESEND_API_KEY, env.EMAIL_FROM, env.EMAIL_TO]);
  }
  if (present(env.DISCORD_WEBHOOK_URL)) {
    identities.discord = hash(["discord", env.DISCORD_WEBHOOK_URL]);
  }
  if (present(env.TELEGRAM_BOT_TOKEN) && present(env.TELEGRAM_CHAT_ID)) {
    identities.telegram = hash(["telegram", env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID]);
  }
  return identities;
}

function emptyState(namespace) {
  return { version: VERSION, namespace, delivered: {} };
}

/**
 * Validate a parsed state object and migrate legacy/invalid/wrong-namespace
 * state to an empty v2 record. Old aggregate markers never prove delivery.
 */
export function normalizeDeliveryState(raw, namespace) {
  if (!SHA256.test(namespace)) throw new Error("Invalid delivery namespace");
  const state = emptyState(namespace);
  if (!plainObject(raw) || raw.version !== VERSION || raw.namespace !== namespace || !plainObject(raw.delivered)) {
    return state;
  }

  for (const [event, entries] of Object.entries(raw.delivered)) {
    if (!EVENT_KEY.test(event) || !plainObject(entries)) continue;
    const confirmed = {};
    for (const [channel, identity] of Object.entries(entries)) {
      if (CHANNELS.has(channel) && typeof identity === "string" && SHA256.test(identity)) {
        confirmed[channel] = identity;
      }
    }
    if (Object.keys(confirmed).length) state.delivered[event] = confirmed;
  }
  const keys = Object.keys(state.delivered);
  for (const old of keys.slice(0, -MAX_EVENTS)) delete state.delivered[old];
  return state;
}

/** Return configured channels for this event that lack confirmed delivery. */
export function pendingChannels(state, event, identities) {
  if (!EVENT_KEY.test(event)) throw new Error("Invalid delivery event key");
  const confirmed = state?.delivered?.[event];
  return Object.entries(identities).filter(([channel, identity]) =>
    CHANNELS.has(channel) && SHA256.test(identity) && confirmed?.[channel] !== identity,
  ).map(([channel]) => channel);
}

/**
 * Record only explicit, successful, non-skipped results from channels requested
 * for this event. Returns whether any new success was recorded.
 */
export function recordDeliveryResults(state, event, identities, results) {
  if (!EVENT_KEY.test(event)) throw new Error("Invalid delivery event key");
  if (state?.version !== VERSION || !plainObject(state.delivered)) throw new Error("Invalid delivery state");
  if (!Array.isArray(results)) return false;

  const previous = state.delivered[event] || {};
  const confirmed = { ...previous };
  let changed = false;
  for (const result of results) {
    if (!plainObject(result) || result.ok !== true || result.skipped === true) continue;
    const channel = result.channel;
    const identity = identities[channel];
    if (!CHANNELS.has(channel) || typeof identity !== "string" || !SHA256.test(identity)) continue;
    if (confirmed[channel] !== identity) {
      confirmed[channel] = identity;
      changed = true;
    }
  }
  if (!changed) return false;
  // Insertion order makes the bounded state retain the most recently updated
  // events, including a formerly partial event completed on a later run.
  delete state.delivered[event];
  state.delivered[event] = confirmed;
  const keys = Object.keys(state.delivered);
  for (const old of keys.slice(0, -MAX_EVENTS)) delete state.delivered[old];
  return true;
}
