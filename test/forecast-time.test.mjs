import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastDateKey, forecastHour, formatForecastRange } from "../public/ui/forecast-time.js";

const epoch = (iso) => Date.parse(iso) / 1000;

test("forecast calendar dates and chart hours follow the selected location", () => {
  const beforeMidnight = epoch("2026-09-22T14:00:00Z");
  const atMidnight = epoch("2026-09-22T15:00:00Z");
  assert.equal(forecastDateKey(beforeMidnight, "Asia/Tokyo"), "2026-09-22");
  assert.equal(forecastDateKey(atMidnight, "Asia/Tokyo"), "2026-09-23");
  assert.equal(forecastHour(beforeMidnight, "Asia/Tokyo"), 23);
  assert.equal(forecastHour(atMidnight, "Asia/Tokyo"), 0);
  assert.equal(forecastHour(atMidnight, "America/New_York"), 11);
});

test("displayed range includes the next local date when it ends at midnight", () => {
  assert.equal(
    formatForecastRange(epoch("2026-09-22T14:00:00Z"), epoch("2026-09-22T15:00:00Z"), "Asia/Tokyo", "en-US"),
    "Tue, Sep 22 11:00 PM – Wed, Sep 23 12:00 AM",
  );
  assert.equal(
    formatForecastRange(epoch("2026-09-22T23:00:00Z"), epoch("2026-09-23T01:00:00Z"), "America/New_York", "en-US"),
    "Tue, Sep 22 7:00 PM – 9:00 PM",
  );
});

test("local hours and dates handle daylight-saving gaps and repeated hours", () => {
  const spring1 = epoch("2026-03-08T06:00:00Z");
  const spring3 = epoch("2026-03-08T07:00:00Z");
  assert.equal(forecastHour(spring1, "America/New_York"), 1);
  assert.equal(forecastHour(spring3, "America/New_York"), 3);
  assert.equal(forecastDateKey(spring1, "America/New_York"), forecastDateKey(spring3, "America/New_York"));

  const fallFirst1 = epoch("2026-11-01T05:00:00Z");
  const fallSecond1 = epoch("2026-11-01T06:00:00Z");
  assert.equal(forecastHour(fallFirst1, "America/New_York"), 1);
  assert.equal(forecastHour(fallSecond1, "America/New_York"), 1);
  assert.equal(forecastDateKey(fallFirst1, "America/New_York"), forecastDateKey(fallSecond1, "America/New_York"));
});
