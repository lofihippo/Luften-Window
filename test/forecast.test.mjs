import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUrl, normalize, fetchForecast } from "../public/core/forecast.js";
import { planForecast } from "../public/core/windows.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS = {
  location: { lat: 40.7128, lon: -74.0060, label: "Home" },
  indoorTempC: 17,
  targetRH: 50,
  coldestSurfaceC: null,
  marginC: 1.5,
  minOutdoorC: 4,
  maxOutdoorC: 29,
  maxRainProb: 30,
  maxWindKmh: 40,
  minWindowHours: 2,
  forecastDays: 3,
};

test("buildUrl includes all parameters", () => {
  const url = buildUrl(SETTINGS);
  assert.ok(url.startsWith("https://api.open-meteo.com/v1/forecast?"));
  assert.ok(url.includes("latitude=40.7128"));
  assert.ok(url.includes("longitude=-74.006"));
  assert.ok(url.includes("timeformat=unixtime"));
  assert.ok(url.includes("forecast_days=3"));
  assert.ok(url.includes("dew_point_2m"));
  assert.ok(url.includes("hourly="));
});

test("buildUrl requests enough past days for minimum-duration qualification within the provider cap", () => {
  for (const [minWindowHours, expected] of [[undefined, "1"], [2, "1"], [24, "1"], [25, "2"], [49, "3"], [3000, "92"]]) {
    const params = new URL(buildUrl({ ...SETTINGS, minWindowHours })).searchParams;
    assert.equal(params.get("past_days"), expected);
    assert.equal(params.get("forecast_days"), "3");
  }
});

test("requested history preserves a qualifying run across a day-boundary forecast refresh", () => {
  const midnight = Date.UTC(2026, 8, 17) / 1000;
  const hourSeconds = 3600;
  const daySeconds = 24 * hourSeconds;
  for (const minWindowHours of [2, 49]) {
    const settings = { ...SETTINGS, minWindowHours };
    const params = new URL(buildUrl(settings)).searchParams;
    const lookbackDays = Number(params.get("past_days"));
    const futureDays = Number(params.get("forecast_days"));
    const start = midnight - (minWindowHours - 1) * hourSeconds;
    const end = midnight + hourSeconds;
    const plans = [midnight - hourSeconds / 2, midnight + hourSeconds / 2].map((now) => {
      const today = Math.floor(now / daySeconds) * daySeconds;
      const first = today - lookbackDays * daySeconds;
      const last = today + futureDays * daySeconds;
      const time = Array.from({ length: (last - first) / hourSeconds }, (_, i) => first + i * hourSeconds);
      const { hours } = normalize({
        timezone: "UTC",
        hourly: {
          time,
          temperature_2m: time.map(() => 20),
          dew_point_2m: time.map((t) => t >= start && t < end ? 1 : 20),
        },
      });
      return planForecast(hours, settings, now);
    });
    for (const plan of plans) {
      assert.equal(plan.status.openNow, true);
      assert.equal(plan.status.currentWindow.start, start);
      assert.equal(plan.status.currentWindow.end, end);
      assert.equal(plan.status.currentWindow.hours, minWindowHours);
    }
  }
});

test("normalize produces hour objects and preserves timezone", async () => {
  const json = JSON.parse(await readFile(path.join(__dirname, "fixtures/openmeteo-sample.json"), "utf8"));
  const { timezone, hours } = normalize(json);
  assert.equal(timezone, "America/New_York");
  assert.equal(hours.length, 72);
  const h = hours[0];
  assert.ok("t" in h && "tempC" in h && "dewPointC" in h && "rh" in h);
  assert.ok("precipProb" in h && "precipMm" in h && "windKmh" in h);
});

test("normalize fills dew point from temp+RH when missing", () => {
  const json = {
    timezone: "UTC",
    hourly: {
      time: [1000],
      temperature_2m: [20],
      dew_point_2m: [null],
      relative_humidity_2m: [50],
      precipitation_probability: [0],
      precipitation: [0],
      wind_speed_10m: [5],
    },
  };
  const { hours } = normalize(json);
  assert.ok(hours[0].dewPointC != null);
  assert.ok(Math.abs(hours[0].dewPointC - 9.26) < 0.1);
});

test("normalize keeps incomplete hours as null alongside usable coverage", () => {
  const json = {
    timezone: "UTC",
    hourly: { time: [1000, 4600], temperature_2m: [null, 20], dew_point_2m: [null, 9] },
  };
  const { hours } = normalize(json);
  assert.equal(hours[0].tempC, null);
  assert.equal(hours[0].dewPointC, null);
  assert.equal(hours[1].rh, null);
});

test("fetchForecast calls fetchImpl and returns normalized result", async () => {
  const json = JSON.parse(await readFile(path.join(__dirname, "fixtures/openmeteo-sample.json"), "utf8"));
  const fetchImpl = async () => ({ ok: true, json: async () => json });
  const { timezone, hours, fetchedAt } = await fetchForecast(SETTINGS, fetchImpl);
  assert.equal(timezone, "America/New_York");
  assert.equal(hours.length, 72);
  assert.ok(fetchedAt > 0);
});

const payload = (hourly = {}, timezone = "UTC") => ({
  timezone,
  hourly: { time: [1000, 4600], temperature_2m: [20, 21], dew_point_2m: [9, 10], ...hourly },
});

test("normalize requires an object envelope, hourly object, and named timezone", () => {
  for (const json of [null, [], false, {}, { timezone: "UTC" }, { timezone: "UTC", hourly: [] }]) {
    assert.throws(() => normalize(json), /forecast|hourly/i);
  }
  for (const timezone of [undefined, null, "", "Not/A_Zone", "+01:00", 5]) {
    assert.throws(() => normalize({ ...payload(), timezone }), /timezone/i);
  }
});

test("normalize uses timestamps as the authoritative hour count", () => {
  const { hours } = normalize(payload({ time: [1000, 4600, 8200] }));
  assert.equal(hours.length, 3);
  assert.deepEqual(hours[2], { t: 8200, tempC: null, dewPointC: null, rh: null, precipProb: null, precipMm: null, windKmh: null });
  assert.throws(() => normalize(payload({ time: [1000] })), /temperature_2m.*time|length/i);
});

test("normalize accepts gaps and named timezones with non-hour offsets", () => {
  const { timezone, hours } = normalize(payload({ time: [1789517700, 1789524900] }, "Asia/Kathmandu"));
  assert.equal(timezone, "Asia/Kathmandu");
  assert.equal(hours[1].t - hours[0].t, 7200);
});

test("normalize rejects missing, empty, malformed, and non-finite timestamps", () => {
  for (const time of [undefined, null, [], {}, "1000", [null], ["1000"], [true], [NaN], [Infinity], [1.5], [8640000000001]]) {
    assert.throws(() => normalize(payload({ time })), /time/i, String(time));
  }
});

test("normalize requires both ends of each hourly interval to fit the Date range", () => {
  const maximum = 8640000000000;
  const singleHour = (t) => payload({ time: [t], temperature_2m: [20], dew_point_2m: [1] });
  for (const t of [-maximum, maximum - 3600]) {
    assert.equal(normalize(singleHour(t)).hours[0].t, t);
  }
  for (const t of [-maximum - 1, maximum - 3599, maximum]) {
    assert.throws(() => normalize(singleHour(t)), /time|Date range/i);
  }
});

test("normalize rejects duplicate, unsorted, overlapping, or non-hourly timestamps", () => {
  for (const time of [[1000, 1000], [4600, 1000], [1000, 2800], [1000, 6400]]) {
    assert.throws(() => normalize(payload({ time })), /time|hour/i);
  }
});

test("normalize allows absent observation arrays and null optional entries", () => {
  const { hours } = normalize(payload({ precipitation_probability: [null, 0], wind_speed_10m: [null, 0] }));
  assert.equal(hours[0].rh, null);
  assert.equal(hours[0].precipProb, null);
  assert.equal(hours[0].precipMm, null);
  assert.equal(hours[0].windKmh, null);
  assert.equal(hours[1].precipProb, 0);
  assert.equal(hours[1].windKmh, 0);
});

test("normalize rejects malformed observation arrays", () => {
  for (const key of ["temperature_2m", "dew_point_2m", "relative_humidity_2m", "precipitation_probability", "precipitation", "wind_speed_10m"]) {
    for (const value of [undefined, null, {}, 1, "20,21", [0, 0, 0]]) {
      assert.throws(() => normalize(payload({ [key]: value })), new RegExp(key));
    }
  }
});

test("normalize never coerces present observations into numbers", () => {
  for (const key of ["temperature_2m", "dew_point_2m", "relative_humidity_2m", "precipitation_probability", "precipitation", "wind_speed_10m"]) {
    for (const value of ["", "0", true, false, {}, [], NaN, Infinity, -Infinity]) {
      assert.throws(() => normalize(payload({ [key]: [value] })), new RegExp(key));
    }
  }
});

test("normalize validates humidity, rain, and wind domains", () => {
  for (const [key, values] of Object.entries({
    relative_humidity_2m: [-1, 101],
    precipitation_probability: [-1, 101],
    precipitation: [-0.1],
    wind_speed_10m: [-0.1],
  })) {
    for (const value of values) assert.throws(() => normalize(payload({ [key]: [value] })), new RegExp(key));
  }
  const { hours } = normalize(payload({ relative_humidity_2m: [0, 100], precipitation_probability: [0, 100], precipitation: [0, 100], wind_speed_10m: [0, 100] }));
  assert.equal(hours[0].rh, 0);
  assert.equal(hours[1].rh, 100);
});

test("normalize derives dew only from usable temperature and positive RH", () => {
  const { hours } = normalize(payload({ time: [1000, 4600, 8200, 11800], temperature_2m: [20, 20, null, -243.04], dew_point_2m: [], relative_humidity_2m: [100, 0, 50, 50] }));
  assert.ok(Math.abs(hours[0].dewPointC - 20) < 1e-9);
  assert.equal(hours[1].dewPointC, null);
  assert.equal(hours[2].dewPointC, null);
  assert.equal(hours[3].dewPointC, null);
});

test("normalize rejects a forecast without any usable temperature and dew point pair", () => {
  for (const hourly of [
    { temperature_2m: [], dew_point_2m: [] },
    { temperature_2m: [null, null] },
    { dew_point_2m: [], relative_humidity_2m: [0, null] },
    { temperature_2m: [20, null], dew_point_2m: [null, 9] },
  ]) assert.throws(() => normalize(payload(hourly)), /usable|temperature.*dew/i);
});

function fakeTimers() {
  const active = new Map();
  let nextId = 0;
  return {
    active,
    setTimer(fn, ms) { const id = ++nextId; active.set(id, { fn, ms }); return id; },
    clearTimer(id) { active.delete(id); },
    fire() { const [{ fn }] = active.values(); fn(); },
  };
}

test("fetchForecast timestamps completion with the injected clock and clears its timer", async () => {
  const timers = fakeTimers();
  let signal;
  const result = await fetchForecast(SETTINGS, async (_url, options) => {
    signal = options.signal;
    assert.equal([...timers.active.values()][0].ms, 10000);
    return { ok: true, json: async () => payload() };
  }, { ...timers, now: () => 1789531200123 });
  assert.equal(result.fetchedAt, 1789531200);
  assert.equal(signal.aborted, false);
  assert.equal(timers.active.size, 0);
});

test("fetchForecast times out a transport that ignores abort", async () => {
  const timers = fakeTimers();
  let signal;
  const request = fetchForecast(SETTINGS, (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { ...timers, timeoutMs: 25 });
  assert.equal([...timers.active.values()][0].ms, 25);
  timers.fire();
  await assert.rejects(request, /timed out.*25|25.*timed out/i);
  assert.equal(signal.aborted, true);
  assert.equal(timers.active.size, 0);
});

test("fetchForecast reports its deadline when the transport also rejects on abort", async () => {
  const timers = fakeTimers();
  const request = fetchForecast(SETTINGS, (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
  }), { ...timers, timeoutMs: 25 });
  timers.fire();
  await assert.rejects(request, /timed out after 25 ms/);
  assert.equal(timers.active.size, 0);
});

test("fetchForecast retains the deadline through normalization", async () => {
  const timers = fakeTimers();
  const json = payload();
  Object.defineProperty(json.hourly, "temperature_2m", {
    get() {
      assert.equal(timers.active.size, 1);
      return [20, 21];
    },
  });
  await fetchForecast(SETTINGS, async () => ({ ok: true, json: async () => json }), timers);
  assert.equal(timers.active.size, 0);
});

test("fetchForecast keeps its timeout active while reading a stalled response body", async () => {
  const timers = fakeTimers();
  let signal;
  let startBody;
  const bodyStarted = new Promise((resolve) => { startBody = resolve; });
  const request = fetchForecast(SETTINGS, async (_url, options) => {
    signal = options.signal;
    return { ok: true, json() { startBody(); return new Promise(() => {}); } };
  }, { ...timers });
  await bodyStarted;
  assert.equal(timers.active.size, 1);
  timers.fire();
  await assert.rejects(request, /timed out/i);
  assert.equal(signal.aborted, true);
  assert.equal(timers.active.size, 0);
});

test("fetchForecast reports transport, HTTP, body, and normalization errors and clears timers", async () => {
  const cases = [
    [async () => { throw new Error("offline"); }, /offline/],
    [async () => ({ ok: false, status: 429 }), /HTTP 429/],
    [async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }), /invalid JSON/],
    [async () => ({ ok: true, json: async () => ({}) }), /forecast|hourly|timezone/i],
  ];
  for (const [fetchImpl, expected] of cases) {
    const timers = fakeTimers();
    await assert.rejects(fetchForecast(SETTINGS, fetchImpl, timers), expected);
    assert.equal(timers.active.size, 0);
  }
});
