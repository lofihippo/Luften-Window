import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLimitC,
  evaluateHours,
  groupWindows,
  currentStatus,
  planForecast,
} from "../public/core/windows.js";

const BASE_SETTINGS = {
  indoorTempC: 17,
  targetRH: 50,
  coldestSurfaceC: null,
  marginC: 1.5,
  minOutdoorC: 4,
  maxOutdoorC: 29,
  maxRainProb: 30,
  maxWindKmh: 40,
  minWindowHours: 2,
  requireDrying: false,
  indoorReading: null,
};

const HOUR = 3600;
const T0 = 1_750_000_000; // arbitrary epoch
function makeHour(t, over = {}) {
  return {
    t,
    tempC: 18,
    dewPointC: 4,
    rh: 40,
    precipProb: 0,
    precipMm: 0,
    windKmh: 10,
    ...over,
  };
}

test("all-dry sequence produces one window with start/end correct", () => {
  const hours = [makeHour(T0), makeHour(T0 + HOUR), makeHour(T0 + 2 * HOUR)];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  const windows = groupWindows(evaluated, BASE_SETTINGS);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, T0);
  assert.equal(windows[0].end, T0 + 3 * HOUR);
  assert.equal(windows[0].hours, 3);
});

test("wet hour splits into two windows", () => {
  const hours = [
    makeHour(T0),
    makeHour(T0 + HOUR),
    makeHour(T0 + 2 * HOUR, { precipMm: 5 }),
    makeHour(T0 + 3 * HOUR),
    makeHour(T0 + 4 * HOUR),
  ];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  const windows = groupWindows(evaluated, BASE_SETTINGS);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].start, T0);
  assert.equal(windows[0].end, T0 + 2 * HOUR);
  assert.equal(windows[1].start, T0 + 3 * HOUR);
});

test("window shorter than minWindowHours is dropped", () => {
  const hours = [makeHour(T0)];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  const windows = groupWindows(evaluated, { ...BASE_SETTINGS, minWindowHours: 2 });
  assert.equal(windows.length, 0);
});

test("coldestSurfaceC lowers limit when below RH-derived dew point", () => {
  const noSurf = computeLimitC(BASE_SETTINGS);
  const withSurf = computeLimitC({ ...BASE_SETTINGS, coldestSurfaceC: 2 });
  assert.ok(withSurf < noSurf, `withSurf=${withSurf} noSurf=${noSurf}`);
});

test("requireDrying uses indoor dew point when lower", () => {
  const base = computeLimitC(BASE_SETTINGS);
  const drying = computeLimitC({
    ...BASE_SETTINGS,
    requireDrying: true,
    indoorReading: { tempC: 20, rh: 40 },
  });
  // Indoor dew point of (20,40) is about 6.0°C, below the default RH limit.
  assert.ok(drying < base, `drying=${drying} base=${base}`);
});

test("precipProb null does not fail; precipProb 80 fails with RAIN_LIKELY", () => {
  const hours = [
    makeHour(T0, { precipProb: null }),
    makeHour(T0 + HOUR, { precipProb: 80 }),
  ];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  assert.equal(evaluated[0].ok, true);
  assert.equal(evaluated[1].ok, false);
  assert.ok(evaluated[1].reasons.includes("RAIN_LIKELY"));
});

test("hours before now are excluded", () => {
  const hours = [makeHour(T0 - 2 * HOUR), makeHour(T0)];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].t, T0);
});

test("currentStatus openNow with closesAt inside a window", () => {
  const hours = [makeHour(T0), makeHour(T0 + HOUR), makeHour(T0 + 2 * HOUR)];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  const windows = groupWindows(evaluated, BASE_SETTINGS);
  const status = currentStatus(evaluated, windows, T0 + HOUR);
  assert.equal(status.openNow, true);
  assert.equal(status.closesAt, T0 + 3 * HOUR);
});

test("currentStatus nextWindow when now is outside a window", () => {
  const hours = [makeHour(T0 + 2 * HOUR), makeHour(T0 + 3 * HOUR)];
  const evaluated = evaluateHours(hours, BASE_SETTINGS, T0 - 1);
  const windows = groupWindows(evaluated, BASE_SETTINGS);
  const status = currentStatus(evaluated, windows, T0);
  assert.equal(status.openNow, false);
  assert.equal(status.nextWindow.start, T0 + 2 * HOUR);
});

test("the active hourly interval remains available at half past", () => {
  const now = T0 + HOUR / 2;
  const evaluated = evaluateHours([makeHour(T0), makeHour(T0 + HOUR)], BASE_SETTINGS, now);
  assert.equal(evaluated[0].t, T0);
  assert.equal(currentStatus(evaluated, groupWindows(evaluated, BASE_SETTINGS), now).openNow, true);
});

test("missing outdoor temperature cannot qualify even with a dry dew point", () => {
  const [hour] = evaluateHours([makeHour(T0, { tempC: null })], BASE_SETTINGS, T0);
  assert.equal(hour.ok, false);
  assert.deepEqual(hour.reasons, ["NO_DATA"]);
});

test("missing timestamps split otherwise dry runs", () => {
  const hours = [makeHour(T0), makeHour(T0 + HOUR), makeHour(T0 + 3 * HOUR), makeHour(T0 + 4 * HOUR)];
  const windows = groupWindows(evaluateHours(hours, BASE_SETTINGS, T0), BASE_SETTINGS);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].end, T0 + 2 * HOUR);
  assert.equal(windows[1].start, T0 + 3 * HOUR);
});

test("closed status explains absent current coverage and a too-short dry run", () => {
  assert.deepEqual(currentStatus([], [], T0).reasons, ["NO_DATA"]);
  const hours = evaluateHours([makeHour(T0)], BASE_SETTINGS, T0);
  assert.deepEqual(currentStatus(hours, [], T0).reasons, ["WINDOW_TOO_SHORT"]);
});

test("planning qualifies full runs before clipping and preserves identity through the final second", () => {
  const hours = [makeHour(T0), makeHour(T0 + HOUR), makeHour(T0 + 2 * HOUR)];
  const original = structuredClone(hours);
  const expectedWindow = planForecast(hours, BASE_SETTINGS, T0).windows[0];
  for (const offset of [0, 1, HOUR / 2, HOUR, 2 * HOUR, 3 * HOUR - 1]) {
    const plan = planForecast(hours, BASE_SETTINGS, T0 + offset);
    assert.deepEqual(plan.windows, [expectedWindow], `offset ${offset}`);
    assert.equal(plan.status.openNow, true);
    assert.equal(plan.status.closesAt, T0 + 3 * HOUR);
    assert.equal(plan.status.remainingSeconds, 3 * HOUR - offset);
    assert.equal(plan.evaluated[0].t, T0 + Math.floor(offset / HOUR) * HOUR);
    assert.deepEqual(plan.status.reasons, []);
  }
  const ended = planForecast(hours, BASE_SETTINGS, T0 + 3 * HOUR);
  assert.deepEqual(ended.evaluated, []);
  assert.deepEqual(ended.windows, []);
  assert.equal(ended.status.openNow, false);
  assert.equal(ended.status.currentWindow, null);
  assert.equal(ended.status.remainingSeconds, null);
  assert.deepEqual(ended.status.reasons, ["NO_DATA"]);
  assert.equal(ended.limitC, computeLimitC(BASE_SETTINGS));
  assert.deepEqual(hours, original);
});

test("an earlier qualifying window does not qualify a short run across a data gap or wet hour", () => {
  for (const middle of [[], [makeHour(T0 + 2 * HOUR, { precipMm: 1 })]]) {
    const hours = [makeHour(T0), makeHour(T0 + HOUR), ...middle, makeHour(T0 + 3 * HOUR)];
    const plan = planForecast(hours, BASE_SETTINGS, T0 + 3 * HOUR + 10);
    assert.deepEqual(plan.windows, []);
    assert.equal(plan.status.openNow, false);
    assert.deepEqual(plan.status.reasons, ["WINDOW_TOO_SHORT"]);
  }
});

test("absent current coverage stays closed even when future windows exist", () => {
  const hours = [makeHour(T0 - 2 * HOUR), makeHour(T0 + HOUR), makeHour(T0 + 2 * HOUR)];
  const plan = planForecast(hours, BASE_SETTINGS, T0);
  assert.equal(plan.status.openNow, false);
  assert.deepEqual(plan.status.reasons, ["NO_DATA"]);
  assert.equal(plan.status.nextWindow.start, T0 + HOUR);
  // Stale or inconsistent caller-supplied windows cannot overrule missing data.
  const status = currentStatus([], [{ start: T0 - HOUR, end: T0 + HOUR }], T0);
  assert.equal(status.openNow, false);
});

test("missing and malformed required observations never qualify", () => {
  for (const field of ["tempC", "dewPointC"]) {
    for (const value of [undefined, null, NaN, Infinity, -Infinity, "4", false]) {
      const plan = planForecast([makeHour(T0, { [field]: value }), makeHour(T0 + HOUR)], BASE_SETTINGS, T0);
      assert.deepEqual(plan.evaluated[0].reasons, ["NO_DATA"], `${field}=${value}`);
      assert.equal(plan.evaluated[0].predictedIndoorRH, null);
      assert.equal(plan.status.openNow, false);
      assert.deepEqual(plan.windows, []);
    }
  }
});

test("missing optional weather is allowed while malformed optional values are not", () => {
  for (const field of ["rh", "precipProb", "precipMm", "windKmh"]) {
    for (const value of [null, undefined]) {
      assert.equal(evaluateHours([makeHour(T0, { [field]: value })], BASE_SETTINGS)[0].ok, true);
    }
    for (const value of [NaN, Infinity, -1, "0", false]) {
      assert.deepEqual(evaluateHours([makeHour(T0, { [field]: value })], BASE_SETTINGS)[0].reasons, ["NO_DATA"]);
    }
  }
});

test("unordered, duplicate, overlapping, and invalid timestamps reject before planning", () => {
  const badSequences = [
    [makeHour(T0 + HOUR), makeHour(T0)], [makeHour(T0), makeHour(T0)],
    [makeHour(T0), makeHour(T0 + HOUR / 2)], [makeHour(T0), makeHour(T0 + HOUR + 1)],
    ...[null, NaN, Infinity, "1750000000", T0 + 0.5, 9e15, -8640000003600].map((t) => [makeHour(t)]),
    [null], ["bad"],
  ];
  for (const hours of badSequences) {
    assert.throws(() => planForecast(hours, BASE_SETTINGS, T0), /Forecast hours/);
    assert.throws(() => groupWindows(hours, BASE_SETTINGS), /Forecast hours/);
  }
  for (const now of [null, NaN, Infinity, "1750000000", 9e15]) {
    assert.throws(() => planForecast([], BASE_SETTINGS, now), /Current time/);
  }
});

test("timestamp intervals remain continuous through DST and offset timezones", () => {
  for (const start of [Date.parse("2026-03-08T06:00:00Z") / 1000, Date.parse("2026-11-01T05:00:00Z") / 1000,
    Date.parse("2026-09-17T00:30:00Z") / 1000]) {
    const hours = [makeHour(start), makeHour(start + HOUR), makeHour(start + 2 * HOUR)];
    const plan = planForecast(hours, BASE_SETTINGS, start + 2.5 * HOUR);
    assert.equal(plan.status.openNow, true);
    assert.equal(plan.status.remainingSeconds, HOUR / 2);
    assert.equal(plan.windows[0].hours, 3);
    assert.equal(plan.windows[0].start, start);
  }
});

test("exact transition boundaries use the new hour's reasons", () => {
  const hours = [makeHour(T0), makeHour(T0 + HOUR), makeHour(T0 + 2 * HOUR, { precipMm: 1 })];
  const plan = planForecast(hours, BASE_SETTINGS, T0 + 2 * HOUR);
  assert.equal(plan.status.openNow, false);
  assert.deepEqual(plan.status.reasons, ["RAINING"]);
  assert.deepEqual(plan.windows, []);
});
