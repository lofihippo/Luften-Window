import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedParts, localDateKey, tomorrowAtHour, formatLocalTime } from "../public/core/zoned-time.js";

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

test("tomorrow 09:00 follows New York's spring and fall DST offsets", () => {
  const springNow = unix("2026-03-07T15:00:00Z");
  const fallNow = unix("2026-10-31T14:00:00Z");
  assert.equal(tomorrowAtHour(springNow, "America/New_York", 9), unix("2026-03-08T13:00:00Z"));
  assert.equal(tomorrowAtHour(fallNow, "America/New_York", 9), unix("2026-11-01T14:00:00Z"));
  assert.equal(localDateKey(springNow, "America/New_York"), "2026-03-07");
  assert.equal(zonedParts(fallNow, "America/New_York").hour, 10);
});

test("tomorrow 09:00 works with a half-hour or quarter-hour timezone offset", () => {
  const now = unix("2026-01-01T18:00:00Z"); // Jan 1 23:45 in Kathmandu
  assert.equal(tomorrowAtHour(now, "Asia/Kathmandu", 9), unix("2026-01-02T03:15:00Z"));
});

test("notification time text uses the forecast location timezone", () => {
  const epoch = unix("2026-03-08T13:00:00Z");
  assert.match(formatLocalTime(epoch, "America/New_York"), /9:00 AM EDT/);
  assert.match(formatLocalTime(epoch, "Europe/Berlin"), /2:00 PM GMT\+1|2:00 PM CET/);
});

test("invalid digest hours fail rather than silently scheduling another time", () => {
  const now = unix("2026-01-01T12:00:00Z");
  for (const hour of [-1, 24, 9.5, NaN]) {
    assert.throws(() => tomorrowAtHour(now, "UTC", hour), /Local hour/);
  }
});
