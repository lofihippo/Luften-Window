// RFC 5545 calendar output shared by browser downloads and the checker feed.
// All time and settings inputs are explicit so identical inputs produce
// identical files, independent of the host clock and timezone.

import { cToF } from "./psychro.js";
import { computeLimitC } from "./windows.js";

const CRLF = "\r\n";
const encoder = new TextEncoder();

function escapeText(value) {
  return String(value).replace(/\\|;|,|\r\n|\r|\n/g, (match) => {
    if (match === "\\") return "\\\\";
    if (match === ";") return "\\;";
    if (match === ",") return "\\,";
    return "\\n";
  });
}

// RFC 5545 measures *octets*, including the whitespace beginning each
// continuation line. Iterate code points so a UTF-8 character is never split.
function foldLine(line) {
  const physical = [];
  let part = "";
  let octets = 0;
  for (const point of line) {
    const bytes = encoder.encode(point).length;
    if (octets + bytes > 75) {
      physical.push(part);
      part = " " + point;
      octets = 1 + bytes;
    } else {
      part += point;
      octets += bytes;
    }
  }
  physical.push(part);
  return physical.join(CRLF);
}

function utcDate(epoch) {
  if (!Number.isSafeInteger(epoch)) throw new Error("Calendar time must be an integer Unix timestamp");
  const date = new Date(epoch * 1000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > 9999) {
    throw new Error("Calendar time is outside the supported four-digit year range");
  }
  const two = (value) => String(value).padStart(2, "0");
  return `${String(year).padStart(4, "0")}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `T${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

function temperature(celsius, units) {
  return units === "F" ? `${Math.round(cToF(celsius))}°F` : `${Math.round(celsius)}°C`;
}

function formatWindowRange(start, end, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "short", day: "numeric", weekday: "short",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return `${formatter.format(new Date(start * 1000))} – ${formatter.format(new Date(end * 1000))}`;
}

function uidFor(window, settings) {
  const { lat, lon } = settings.location;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Calendar location must have finite coordinates");
  }
  // Preserve the complete coordinates, avoiding collisions from rounding.
  return `openwindow-${encodeURIComponent(String(lat))}-${encodeURIComponent(String(lon))}-${window.start}@openwindow`;
}

/**
 * Build a subscription feed or a single-window download.
 * `stampEpoch` is the publication time supplied by the caller; this function
 * never uses Date.now(), so a repeated unchanged publication is byte-stable.
 */
export function buildCalendar({ settings, windows, timezone, stampEpoch }) {
  if (!Array.isArray(windows)) throw new Error("Calendar windows must be an array");
  if (!settings?.location || !Number.isFinite(computeLimitC(settings))) {
    throw new Error("Calendar settings must have a finite dew-point limit");
  }
  if (typeof timezone !== "string" || !timezone) {
    throw new Error("Calendar timezone is required");
  }
  // Check the IANA zone even if no events are present.
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  const stamp = utcDate(stampEpoch);
  const limit = temperature(computeLimitC(settings), settings.units);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Luften Window//Window Planner//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Luften Window",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const window of windows) {
    if (!window || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end)
        || window.end <= window.start || (window.minDewC != null && !Number.isFinite(window.minDewC))
        || (window.maxPredictedRH != null && !Number.isFinite(window.maxPredictedRH))) {
      throw new Error("Calendar window has invalid times or metrics");
    }
    const desc = [`Dew-point limit ${limit}`];
    if (window.minDewC != null) {
      desc.push(`lowest forecast dew point ${temperature(window.minDewC, settings.units)}`);
    }
    if (window.maxPredictedRH != null) {
      desc.push(`highest predicted indoor RH ${Math.round(window.maxPredictedRH)}%`);
    }
    const label = settings.location.label;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uidFor(window, settings)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcDate(window.start)}`,
      `DTEND:${utcDate(window.end)}`,
      `SUMMARY:${escapeText("Windows OK")}`,
      `DESCRIPTION:${escapeText(desc.join("; "))}`,
    );
    if (label) lines.push(`LOCATION:${escapeText(label)}`);
    lines.push(
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(`Open the windows (${formatWindowRange(window.start, window.end, timezone)})`)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

function validUtcDateTime(value) {
  const match = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, 0);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute && parsed.getUTCSeconds() === second;
}

// Validate the structural subset emitted above before offering a shared feed
// to browser users. This is deliberately narrower than a general ICS parser.
export function isCalendarFeed(text) {
  if (typeof text !== "string" || text.length > 1_000_000 || !text.endsWith(CRLF)
      || /[\r\n]/.test(text.replaceAll(CRLF, ""))) return false;
  const physical = text.slice(0, -2).split(CRLF);
  if (physical.some((line, i) => encoder.encode(line).length > 75
      || (i === 0 && /^[ \t]/.test(line)))) return false;
  const lines = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line)) {
      if (lines.length === 0 || line.length === 1) return false;
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR") return false;

  const stack = [];
  const uids = new Set();
  let calendarFields = null;
  let eventFields = null;
  let alarmFields = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:")) {
      const component = line.slice(6);
      const parent = stack.at(-1);
      if (!((component === "VCALENDAR" && parent === undefined)
          || (component === "VEVENT" && parent === "VCALENDAR")
          || (component === "VALARM" && parent === "VEVENT"))) return false;
      if (component === "VCALENDAR" && calendarFields !== null) return false;
      stack.push(component);
      if (component === "VCALENDAR") calendarFields = new Map();
      if (component === "VEVENT") eventFields = new Map();
      if (component === "VALARM") alarmFields = new Map();
      continue;
    }
    if (line.startsWith("END:")) {
      const component = line.slice(4);
      if (stack.pop() !== component) return false;
      if (component === "VALARM" && (alarmFields.get("TRIGGER")?.length !== 1
          || alarmFields.get("ACTION")?.length !== 1
          || alarmFields.get("DESCRIPTION")?.length !== 1)) return false;
      if (component === "VEVENT") {
        for (const key of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION"]) {
          if (eventFields.get(key)?.length !== 1) return false;
        }
        const [uid] = eventFields.get("UID");
        if (!uid || uids.has(uid)) return false;
        uids.add(uid);
        for (const key of ["DTSTAMP", "DTSTART", "DTEND"]) {
          if (!validUtcDateTime(eventFields.get(key)[0])) return false;
        }
        if (eventFields.get("DTEND")[0] <= eventFields.get("DTSTART")[0]) return false;
      }
      if (component === "VCALENDAR" && (calendarFields.get("VERSION")?.length !== 1
          || calendarFields.get("VERSION")[0] !== "2.0"
          || calendarFields.get("PRODID")?.length !== 1)) return false;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1 || stack.length === 0) return false;
    const name = line.slice(0, colon).split(";", 1)[0];
    if (!/^[A-Z0-9-]+$/.test(name)) return false;
    const current = stack.at(-1) === "VALARM" ? alarmFields
      : stack.at(-1) === "VEVENT" ? eventFields : calendarFields;
    const values = current.get(name) || [];
    values.push(line.slice(colon + 1));
    current.set(name, values);
  }
  return stack.length === 0 && calendarFields !== null;
}
