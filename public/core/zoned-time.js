// Small timezone helpers shared by browser-independent checker behavior.
// Keep calendar dates in the forecast location even across DST transitions.

const partsFormatters = new Map();
const messageFormatters = new Map();

function formatter(cache, timeZone, options) {
  let value = cache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    cache.set(timeZone, value);
  }
  return value;
}

export function zonedParts(epoch, timeZone) {
  const formatted = formatter(partsFormatters, timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1000));
  const get = (type) => Number(formatted.find((part) => part.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute") };
}

export function localDateKey(epoch, timeZone) {
  const { year, month, day } = zonedParts(epoch, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The target is 09:00, which exists even on ordinary DST transition days.
// Iterate the timezone offset because Date.UTC alone represents UTC, not a
// wall-clock time in the forecast location.
function epochAtLocalTime({ year, month, day, hour, minute = 0 }, timeZone) {
  const desired = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(guess, timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 1000;
    const difference = desired - represented;
    if (difference === 0) return guess;
    guess += difference;
  }
  const result = zonedParts(guess, timeZone);
  if (result.year !== year || result.month !== month || result.day !== day
      || result.hour !== hour || result.minute !== minute) {
    throw new Error("Requested local time does not exist in forecast timezone");
  }
  return guess;
}

export function tomorrowAtHour(epoch, timeZone, hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("Local hour must be 0–23");
  const { year, month, day } = zonedParts(epoch, timeZone);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return epochAtLocalTime({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(), hour }, timeZone);
}

export function formatLocalTime(epoch, timeZone) {
  return formatter(messageFormatters, timeZone, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(epoch * 1000));
}
