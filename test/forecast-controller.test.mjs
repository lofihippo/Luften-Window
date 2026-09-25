import { test } from "node:test";
import assert from "node:assert/strict";
import { createForecastController, validateForecastHours } from "../public/ui/forecast-controller.js";
import { planForecast } from "../public/core/windows.js";

const HOUR = 3600;
const BASE = 1767268800; // 2026-01-01 12:00 UTC
const LOCATION_A = { lat: 40.7128, lon: -74.0060, label: "A" };
const LOCATION_B = { lat: 40.7128, lon: -74.006, label: "B" };

function settings(location = LOCATION_A, overrides = {}) {
  return {
    location: structuredClone(location), units: "C", indoorTempC: 20, targetRH: 60, coldestSurfaceC: null,
    marginC: 0, minOutdoorC: 0, maxOutdoorC: 35, maxRainProb: 30,
    maxWindKmh: 40, minWindowHours: 2, requireDrying: false,
    indoorReading: null, forecastDays: 3, ...overrides,
  };
}

function hours(start = BASE - HOUR, dews = [5, 5, 5, 5]) {
  return dews.map((dewPointC, i) => ({
    t: start + i * HOUR, tempC: 18, dewPointC, rh: 40,
    precipProb: 0, precipMm: 0, windKmh: 5,
  }));
}

function live(location = LOCATION_A, at = BASE, raw = hours()) {
  return { timezone: "UTC", hours: raw, fetchedAt: at, location };
}

function background(location = LOCATION_A, at = BASE, raw = hours()) {
  return {
    location, timezone: "UTC", generatedAt: new Date(at * 1000).toISOString(),
    forecastHours: raw,
    // Deliberately false serialized advice: the browser must replan raw hours.
    status: { openNow: true, reasons: [] }, windows: [{ start: BASE - HOUR, end: BASE + 10 * HOUR }],
    hours: raw.map((h) => ({ ...h, ok: true })),
  };
}

function checkStatus(forecast, at) {
  return { checkedAt: new Date(at * 1000).toISOString(), generatedAt: forecast.generatedAt };
}

function cached(location = LOCATION_A, at = BASE, raw = hours()) {
  return { location, timezone: "UTC", fetchedAt: at, hours: raw };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ fetchLive = async () => live(), fetchBackground = async () => null,
  fetchCheckStatus = async () => null, checkFeed = async () => false,
  readCache = () => null, now = BASE } = {}) {
  const states = [];
  const writes = [];
  let clock = now;
  const controller = createForecastController({
    fetchLive, fetchBackground, fetchCheckStatus, checkFeed, readCache,
    writeCache: (value) => writes.push(value),
    now: () => clock,
    onState: (value) => states.push(value),
  });
  return { controller, states, writes, setNow: (value) => { clock = value; } };
}

test("delayed location A cannot replace B's render or cache", async () => {
  const slowA = deferred();
  const h = harness({ fetchLive: (snapshot) => snapshot.location.label === "A" ? slowA.promise : Promise.resolve(live(LOCATION_B)) });
  const requestA = h.controller.refresh(settings());
  await h.controller.refresh(settings(LOCATION_B));
  slowA.resolve(live(LOCATION_A));
  await requestA;
  assert.equal(h.controller.getState().source, "live");
  assert.equal(h.controller.getState().phase, "ready");
  assert.deepEqual(h.writes.map((entry) => entry.location.label), ["B"]);
  assert.equal(h.states.at(-1).phase, "ready");
});

test("an in-flight request keeps its settings snapshot after the caller edits inputs", async () => {
  const slow = deferred();
  const original = settings();
  const expected = structuredClone(original);
  const raw = hours();
  const h = harness({ fetchLive: () => slow.promise });
  const request = h.controller.refresh(original);
  original.targetRH = 20;
  original.location.lat = LOCATION_B.lat;
  slow.resolve(live(LOCATION_A, BASE, raw));
  await request;
  assert.deepEqual(h.controller.getState().windows, planForecast(raw, expected, BASE).windows);
  assert.equal(h.writes[0].location.lat, LOCATION_A.lat);
});

test("background forecast uses current RH, surface, drying, and full raw history", async () => {
  const raw = hours(BASE - 2 * HOUR, [5, 5, 5, 5]);
  const custom = settings(LOCATION_A, {
    targetRH: 35, coldestSurfaceC: 7, requireDrying: true,
    indoorReading: { tempC: 20, rh: 35 },
  });
  const h = harness({ fetchLive: async () => { throw new Error("offline"); },
    fetchBackground: async () => background(LOCATION_A, BASE, raw) });
  await h.controller.refresh(custom);
  const view = h.controller.getState();
  assert.equal(view.source, "background");
  assert.deepEqual(view.windows, planForecast(raw, custom, BASE).windows);
  assert.equal(view.status.openNow, false);
  assert.equal(view.status.reasons.includes("DEW_TOO_HIGH"), true);
  assert.equal(h.writes.length, 0);
});

test("expired background advice is rejected and a valid cache is replanned", async () => {
  const h = harness({ fetchLive: async () => { throw new Error("offline"); },
    fetchBackground: async () => background(LOCATION_A, BASE, hours(BASE - 5 * HOUR, [5, 5])),
    readCache: () => cached() });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().source, "cache");
  assert.equal(h.controller.getState().status.openNow, true);
});

test("a future-only background forecast reports missing current coverage without false opening advice", async () => {
  const future = hours(BASE + HOUR, [5, 5, 5]);
  const h = harness({ fetchLive: async () => { throw new Error("offline"); },
    fetchBackground: async () => background(LOCATION_A, BASE, future) });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().source, "background");
  assert.equal(h.controller.getState().status.openNow, false);
  assert.ok(h.controller.getState().status.reasons.includes("NO_DATA"));
  assert.equal(h.controller.getState().windows.length, 1);
});

test("malformed background schema, timezone, or location proceeds to valid cache", async () => {
  for (const bad of [
    { ...background(), forecastHours: undefined },
    { ...background(), timezone: "invalid/zone" },
    { ...background(), location: { lat: "42", lon: LOCATION_A.lon } },
    { ...background(), forecastHours: [{ ...hours()[0], dewPointC: "5" }] },
  ]) {
    const h = harness({ fetchLive: async () => { throw new Error("offline"); },
      fetchBackground: async () => bad, readCache: () => cached() });
    await h.controller.refresh(settings());
    assert.equal(h.controller.getState().source, "cache");
  }
  assert.equal(validateForecastHours(hours()), true);
  assert.equal(validateForecastHours([{ ...hours()[0], rh: Infinity }]), false);
});

test("total failure clears prior cards and reports unavailable rather than a closed forecast", async () => {
  let fail = false;
  const h = harness({ fetchLive: async () => { if (fail) throw new Error("offline"); return live(); },
    fetchBackground: async () => null });
  await h.controller.refresh(settings());
  assert.ok(h.controller.getState().windows.length > 0);
  fail = true;
  await h.controller.refresh(settings());
  const view = h.controller.getState();
  assert.equal(view.phase, "unavailable");
  assert.equal(view.source, null);
  assert.deepEqual(view.windows, []);
  assert.deepEqual(view.evaluated, []);
  assert.equal(view.status, null);
});

test("minute tick replans an ongoing window and expires it without a network request", async () => {
  let calls = 0;
  const raw = hours(BASE - HOUR, [5, 5, 15, 15]);
  const h = harness({ fetchLive: async () => { calls++; return live(LOCATION_A, BASE, raw); } });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().status.openNow, true);
  assert.equal(h.controller.getState().status.remainingSeconds, HOUR);
  h.setNow(BASE + HOUR + 60);
  h.controller.tick();
  assert.equal(h.controller.getState().phase, "ready");
  assert.equal(h.controller.getState().status.openNow, false);
  assert.equal(calls, 1);
  h.setNow(BASE + 3 * HOUR);
  h.controller.tick();
  assert.equal(h.controller.getState().phase, "unavailable");
});

test("stale or future-dated cache is not used", async () => {
  for (const at of [BASE - 7 * HOUR, BASE + 10 * 60]) {
    const h = harness({ fetchLive: async () => { throw new Error("offline"); },
      readCache: () => cached(LOCATION_A, at) });
    await h.controller.refresh(settings());
    assert.equal(h.controller.getState().phase, "unavailable");
  }
});

test("a matching recent check keeps an unchanged seven-hour-old background publication usable", async () => {
  const published = background(LOCATION_A, BASE, hours(BASE + 8 * HOUR, [5, 5, 5]));
  const h = harness({ now: BASE + 7 * HOUR,
    fetchLive: async () => { throw new Error("offline"); },
    fetchBackground: async () => published,
    fetchCheckStatus: async () => checkStatus(published, BASE + 7 * HOUR),
    checkFeed: async () => true });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().source, "background");
  assert.equal(h.controller.getState().fetchedAt, BASE + 7 * HOUR);
  assert.equal(h.controller.getState().checker.publishedAt, BASE);
  assert.equal(h.controller.getState().checker.checkedAt, BASE + 7 * HOUR);
  assert.equal(h.controller.getState().feedAvailable, true);
  assert.equal(h.controller.getState().windows.length, 1);
  h.setNow(BASE + 8 * HOUR + 60);
  h.controller.tick();
  assert.equal(h.controller.getState().status.openNow, true);
  assert.equal(h.controller.getState().feedAvailable, true);
});

test("missing, mismatched, malformed, and future check markers cannot extend stale advice", async () => {
  const published = background(LOCATION_A, BASE, hours(BASE + 8 * HOUR, [5, 5, 5]));
  for (const marker of [null, { ...checkStatus(published, BASE + 7 * HOUR), generatedAt: "other" },
    { checkedAt: "invalid", generatedAt: published.generatedAt },
    checkStatus(published, BASE + 7 * HOUR + 10 * 60),
    checkStatus(published, BASE - HOUR)]) {
    const h = harness({ now: BASE + 7 * HOUR,
      fetchLive: async () => { throw new Error("offline"); },
      fetchBackground: async () => published,
      fetchCheckStatus: async () => marker,
      checkFeed: async () => true });
    await h.controller.refresh(settings());
    assert.equal(h.controller.getState().phase, "unavailable");
    assert.equal(h.controller.getState().feedAvailable, false);
  }
});

test("a missing marker preserves the legacy six-hour publication fallback", async () => {
  const published = background(LOCATION_A, BASE, hours(BASE - HOUR, [5, 5, 5]));
  const h = harness({ now: BASE + HOUR,
    fetchLive: async () => { throw new Error("offline"); },
    fetchBackground: async () => published,
    checkFeed: async () => true });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().source, "background");
  assert.equal(h.controller.getState().fetchedAt, BASE);
  assert.equal(h.controller.getState().checker.checkedAt, null);
  assert.equal(h.controller.getState().feedAvailable, true);
});

test("checker publication metadata and feed availability update after live success", async () => {
  const metadata = deferred();
  const h = harness({ fetchBackground: () => metadata.promise, checkFeed: async () => true });
  const request = h.controller.refresh(settings());
  await Promise.resolve();
  assert.equal(h.controller.getState().source, "live");
  assert.equal(h.controller.getState().checker, null);
  metadata.resolve(background(LOCATION_B));
  await request;
  assert.equal(h.controller.getState().source, "live");
  assert.equal(h.controller.getState().checker.location.label, "B");
  assert.equal(h.controller.getState().feedAvailable, true);

  const withoutFeed = harness({ fetchBackground: async () => background(), checkFeed: async () => false });
  await withoutFeed.controller.refresh(settings());
  assert.equal(withoutFeed.controller.getState().feedAvailable, false);
});

test("calendar subscription hides when checker coverage expires, even if the live forecast remains valid", async () => {
  const liveHours = hours(BASE - HOUR, [5, 5, 5, 5, 5, 5, 5]);
  const checkerHours = hours(BASE - HOUR, [5, 5]);
  const h = harness({ fetchLive: async () => live(LOCATION_A, BASE, liveHours),
    fetchBackground: async () => background(LOCATION_A, BASE, checkerHours),
    checkFeed: async () => true });
  await h.controller.refresh(settings());
  assert.equal(h.controller.getState().feedAvailable, true);
  h.setNow(BASE + HOUR);
  h.controller.tick();
  assert.equal(h.controller.getState().phase, "ready");
  assert.equal(h.controller.getState().feedAvailable, false);
});

test("invalidating settings prevents a pending request from restoring advice", async () => {
  const slow = deferred();
  const h = harness({ fetchLive: () => slow.promise });
  const request = h.controller.refresh(settings());
  h.controller.invalidate();
  slow.resolve(live());
  await request;
  assert.equal(h.controller.getState().phase, "unavailable");
  assert.equal(h.writes.length, 0);
});
