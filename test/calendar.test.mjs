import test from "node:test";
import assert from "node:assert/strict";
import { buildCalendar, isCalendarFeed } from "../public/core/calendar.js";
import { computeLimitC } from "../public/core/windows.js";

const settings = {
  location: { lat: 40.7128123, lon: -74.0060123, label: "New York" },
  units: "F", indoorTempC: 17, targetRH: 50, coldestSurfaceC: null,
  marginC: 1.5, requireDrying: false,
};
const start = Date.parse("2026-11-01T05:00:00Z") / 1000;
const window = { start, end: start + 3600, minDewC: -3, maxPredictedRH: 39.4 };
const stampEpoch = Date.parse("2026-10-31T12:00:00Z") / 1000;

function calendar(overrides = {}) {
  return buildCalendar({ settings, windows: [window], timezone: "America/New_York", stampEpoch, ...overrides });
}

function unfold(text) {
  return text.replaceAll("\r\n ", "");
}

test("calendar is deterministic, has stable full-coordinate UIDs, and describes the actual limit", () => {
  const first = calendar();
  assert.equal(calendar(), first);
  const otherStamp = calendar({ stampEpoch: stampEpoch + 60 });
  const uid = unfold(first).match(/^UID:(.+)$/m)?.[1];
  assert.ok(uid);
  assert.equal(unfold(otherStamp).match(/^UID:(.+)$/m)?.[1], uid);
  assert.match(uid, /40\.7128123--74\.0060123-/);
  assert.match(first, /DTSTAMP:20261031T120000Z\r\n/);
  const plain = unfold(first);
  assert.match(plain, new RegExp(`Dew-point limit ${Math.round(computeLimitC(settings) * 9 / 5 + 32)}°F`));
  assert.match(plain, /lowest forecast dew point 27°F/);
  assert.match(plain, /highest predicted indoor RH 39%/);
  assert.doesNotMatch(plain, /dew point ≤ 27°F/);
});

test("calendar escapes text and folds every physical line within 75 UTF-8 octets", () => {
  const label = "É 😀 München, cafés; back\\slash\r\n" + "市区😀".repeat(25);
  const ics = calendar({ settings: { ...settings, location: { ...settings.location, label } } });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.doesNotMatch(ics.replaceAll("\r\n", ""), /[\r\n]/);
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `line is too long: ${line}`);
  }
  assert.match(unfold(ics), /LOCATION:É 😀 München\\, cafés\\; back\\\\slash\\n市区😀/);
  assert.match(ics, /\r\n /);
});

test("alarm text follows the forecast timezone across a repeated DST hour", () => {
  const plain = unfold(calendar());
  assert.match(plain, /Nov 1\\, 2026\\, 1:00 AM EDT/);
  assert.match(plain, /Nov 1\\, 2026\\, 1:00 AM EST/);
  assert.match(plain, /DTSTART:20261101T050000Z/);
  assert.match(plain, /DTEND:20261101T060000Z/);
});

test("calendar rejects malformed publication inputs", () => {
  assert.throws(() => calendar({ stampEpoch: undefined }), /timestamp/);
  assert.throws(() => calendar({ timezone: "Broken/Zone" }), /time zone/i);
  assert.throws(() => calendar({ windows: [{ ...window, end: start }] }), /invalid times/);
});

test("feed validator accepts generated calendars, including an empty feed", () => {
  assert.equal(isCalendarFeed(calendar()), true);
  assert.equal(isCalendarFeed(calendar({ windows: [] })), true);
  assert.equal(isCalendarFeed(calendar({ settings: { ...settings,
    location: { ...settings.location, label: "É 😀".repeat(40) } } })), true);
});

test("feed validator rejects truncated events and malformed dates despite calendar wrappers", () => {
  const good = calendar();
  for (const corrupt of [
    good.replace("END:VEVENT\r\n", ""),
    good.replace(/^UID:.*\r\n/m, ""),
    good.replace("DTSTART:20261101T050000Z", "DTSTART:20261301T050000Z"),
    good.replace("END:VCALENDAR\r\n", "END:VCALENDAR\n"),
    good.replace("VERSION:2.0\r\n", ""),
    good.replace("END:VCALENDAR\r\n", "END:VEYEAR\r\n"),
    good + good,
  ]) {
    assert.equal(isCalendarFeed(corrupt), false, corrupt.slice(0, 100));
  }
});
