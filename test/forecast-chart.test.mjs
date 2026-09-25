import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartDomain, closestHourIndex, seriesSegments, chartHourOutcome, createChartModel,
} from "../public/ui/forecast-chart.js";

const HOUR = 3600;
const START = Date.parse("2026-09-23T12:00:00Z") / 1000;
const settings = { units: "C", indoorTempC: 20, targetRH: 50, coldestSurfaceC: null, marginC: 1.5 };
const hour = (offset, extra = {}) => ({
  t: START + offset * HOUR, tempC: 15, dewPointC: 8, predictedIndoorRH: 45,
  limitC: 7.5, rh: 63, precipProb: 0, ok: false, reasons: ["DEW_TOO_HIGH"], ...extra,
});
const modelFor = (extra = {}) => createChartModel({
  hours: Array.from({ length: 73 }, (_, index) => hour(index)), windows: [],
  settings, now: START + 300, ...extra,
});

test("numeric chart domains contain observations and both reference limits", () => {
  for (const units of ["C", "F"]) {
    const model = modelFor({
      hours: [hour(0, { dewPointC: -10, predictedIndoorRH: 5, limitC: 30 })],
      settings: { ...settings, units, targetRH: 80 },
    });
    assert.ok(model.dew.min <= model.toDisplay(-10));
    assert.ok(model.dew.max >= model.limit);
    assert.ok(model.rh.min <= 5 && model.rh.max >= 80);
    assert.ok(model.yDew(model.limit) >= model.top && model.yDew(model.limit) <= model.bottom);
    assert.ok(model.yRH(80) >= model.top && model.yRH(80) <= model.bottom);
    assert.ok(model.dew.ticks.length >= 3 && model.rh.ticks.length >= 3);
    assert.equal(model.limit, units === "F" ? 86 : 30);
  }
});

test("flat and missing series produce finite domains with readable numeric ticks", () => {
  for (const values of [[], [null, undefined, NaN], [0, 0], [-20, -20]]) {
    const domain = chartDomain(values);
    assert.ok(Number.isFinite(domain.min) && Number.isFinite(domain.max));
    assert.ok(domain.max > domain.min);
    assert.ok(domain.ticks.length >= 2);
    assert.ok(domain.ticks.every(Number.isFinite));
  }
  const humidity = chartDomain([0, 100], { percentage: true });
  assert.equal(humidity.min, 0);
  assert.equal(humidity.max, 100);
  assert.ok(humidity.ticks.includes(0) && humidity.ticks.includes(100));
});

test("series break at missing observations and real timestamp gaps", () => {
  const hours = [hour(0), hour(1), hour(2, { dewPointC: null }), hour(3), hour(5), hour(6)];
  const segments = seriesSegments(hours, (item) => item.dewPointC);
  assert.deepEqual(segments.map((segment) => segment.map((point) => point.t)), [
    [START, START + HOUR], [START + 3 * HOUR], [START + 5 * HOUR, START + 6 * HOUR],
  ]);
  const model = modelFor({ hours });
  const missingHourGap = model.x(START + 5 * HOUR) - model.x(START + 3 * HOUR);
  const hourlyGap = model.x(START + HOUR) - model.x(START);
  assert.ok(Math.abs(missingHourGap - 2 * hourlyGap) < 1e-9);
});

test("24, 48 and 72 hour views use elapsed timestamps and exclude their end boundary", () => {
  for (const duration of [24, 48, 72]) {
    const model = modelFor({ viewHours: duration });
    assert.equal(model.start, START);
    assert.equal(model.end, START + duration * HOUR);
    assert.equal(model.hours.length, duration);
    assert.equal(model.hours.at(-1).t, model.end - HOUR);
    assert.equal(model.height, 302);
  }
  assert.equal(modelFor({ viewHours: 12 }).end, START + 24 * HOUR);
  assert.equal(modelFor({ hours: [] }), null);
  assert.equal(modelFor({ hours: [hour(-2)] }), null);
});

test("window bands clip to the view and never mark isolated acceptable hours as qualified", () => {
  const windows = [
    { start: START - 2 * HOUR, end: START + HOUR },
    { start: START + 23 * HOUR, end: START + 27 * HOUR },
    { start: START + 25 * HOUR, end: START + 28 * HOUR },
    { start: START - 5 * HOUR, end: START },
  ];
  const model = modelFor({ windows });
  assert.deepEqual(model.bands, [
    { start: START, end: START + HOUR },
    { start: START + 23 * HOUR, end: START + 24 * HOUR },
  ]);
  assert.equal(chartHourOutcome(hour(0, { ok: true }), windows), "Suitable opening window");
  assert.equal(chartHourOutcome(hour(1, { ok: true }), windows), "Dry period shorter than the minimum window");
  assert.equal(chartHourOutcome(hour(1, { reasons: ["RAIN_LIKELY", "TOO_WINDY"] }), windows), "Rain likely; Wind too strong");
  assert.equal(chartHourOutcome(hour(1, { reasons: [] }), windows), "Required forecast data missing");
});

test("selected timestamp survives minute updates, view changes and replacement observations", () => {
  const selectedTime = START + 12 * HOUR;
  const initial = modelFor({ selectedTime });
  for (const extra of [
    { now: START + 360 },
    { now: START + HOUR + 60 },
    { viewHours: 72 },
    { hours: Array.from({ length: 48 }, (_, index) => hour(index, { dewPointC: 9 })) },
  ]) {
    const model = modelFor({ selectedTime, ...extra });
    assert.equal(model.hours[model.selectedIndex].t, initial.hours[initial.selectedIndex].t);
  }
  const advanced = modelFor({ selectedTime: START, now: START + HOUR + 60 });
  assert.equal(advanced.hours[advanced.selectedIndex].t, START + HOUR);
  assert.equal(closestHourIndex([], START), -1);
  assert.equal(closestHourIndex([hour(0), hour(2)], START + HOUR), 0);
  assert.equal(closestHourIndex([hour(0), hour(2)], START + 1.75 * HOUR), 1);
});

test("initial inspection selects the current interval after its half-hour point", () => {
  const now = START + 45 * 60;
  const initial = modelFor({ now });
  assert.equal(initial.hours[initial.selectedIndex].t, START);
  const explicit = modelFor({ now, selectedTime: now });
  assert.equal(explicit.hours[explicit.selectedIndex].t, START + HOUR);
  const future = modelFor({ now, hours: [hour(3), hour(4)] });
  assert.equal(future.hours[future.selectedIndex].t, START + 3 * HOUR);
});

test("future-only coverage retains an empty view model so longer timespans remain available", () => {
  const hours = [hour(30), hour(31)];
  const short = modelFor({ hours, viewHours: 24 });
  assert.ok(short);
  assert.deepEqual(short.hours, []);
  assert.equal(short.selectedIndex, -1);
  const longer = modelFor({ hours, viewHours: 48 });
  assert.equal(longer.hours.length, 2);
  assert.equal(longer.hours[longer.selectedIndex].t, START + 30 * HOUR);
});
