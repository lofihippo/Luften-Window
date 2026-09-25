import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { run } from "../scripts/check.mjs";
import { planForecast } from "../public/core/windows.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/openmeteo-sample.json", import.meta.url), "utf8"));
const HOUR = 3600;
const START = fixture.hourly.time[0] + 12 * HOUR;
const OUTPUT = "/virtual/openwindow/windows.json";
const STATE = "/virtual/private/state.json";
const CALENDAR = "/virtual/openwindow/windows.ics";
const CHECK_STATUS = "/virtual/openwindow/check-status.json";

// Independent of the user's deployable config.json and environment.
const BASE_CONFIG = {
  location: { lat: 40.7128, lon: -74.0060, label: "Fixture home" },
  units: "F", indoorTempC: 17, targetRH: 50, coldestSurfaceC: null,
  marginC: 1.5, minOutdoorC: 4, maxOutdoorC: 29, maxRainProb: 30,
  maxWindKmh: 40, minWindowHours: 2, requireDrying: false,
  indoorReading: null, forecastDays: 3,
  notify: { enabled: false, realtime: false, leadHours: 1, digest: { enabled: false, hourLocal: 7 } },
};

let networkGuard;
beforeEach(() => {
  networkGuard = mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected real HTTP request in checker tests");
  });
});
afterEach(() => {
  const calls = networkGuard.mock.callCount();
  mock.restoreAll();
  // Check outside production catch blocks, which may swallow transport errors.
  assert.equal(calls, 0, "HTTP must use the injected fixture transport");
});

function makeMemoryFs({ failWrite, failMkdir, failRename } = {}) {
  const store = new Map();
  const reads = [];
  const writes = [];
  const renames = [];
  const removals = [];
  const directories = [];
  return {
    store, reads, writes, renames, removals, directories,
    fs: {
      readFile: async (file) => {
        reads.push(file);
        return store.get(file) ?? null;
      },
      mkdir: async (directory, options) => {
        directories.push({ directory, options });
        if (failMkdir) throw new Error("mock directory failure");
      },
      writeFile: async (file, content) => {
        writes.push({ file, content });
        if (file === failWrite || (file.startsWith(`${failWrite}.`) && file.endsWith(".tmp"))) {
          throw new Error("mock write failure");
        }
        store.set(file, content);
      },
      rename: async (from, to) => {
        renames.push({ from, to });
        if (to === failRename && from.endsWith(".tmp")) throw new Error("mock rename failure");
        if (!store.has(from)) throw Object.assign(new Error("missing file"), { code: "ENOENT" });
        store.set(to, store.get(from));
        store.delete(from);
      },
      unlink: async (file) => {
        removals.push(file);
        if (!store.has(file)) throw Object.assign(new Error("missing file"), { code: "ENOENT" });
        store.delete(file);
      },
    },
  };
}

function makeForecast(dews = [4, 4, 4]) {
  return {
    timezone: "UTC",
    hourly: {
      time: dews.map((_, i) => START + i * HOUR),
      temperature_2m: dews.map(() => 18), dew_point_2m: dews,
      relative_humidity_2m: dews.map(() => 40),
      precipitation_probability: dews.map(() => 0),
      precipitation: dews.map(() => 0), wind_speed_10m: dews.map(() => 10),
    },
  };
}

function makeHarness({ forecast = fixture, config = {}, env = {}, memory = makeMemoryFs(), notifyImpl } = {}) {
  const notifications = [];
  const requests = [];
  const settings = { ...structuredClone(BASE_CONFIG), ...config };
  const deps = {
    config: settings, env: { NTFY_TOPIC: "fixture-topic", ...env }, fs: memory.fs, output: OUTPUT, stateFile: STATE,
    now: fixture.hourly.time[0] + HOUR,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => structuredClone(forecast) };
    },
    notifyImpl: async (message, options) => {
      notifications.push(message);
      return notifyImpl ? notifyImpl(message, options) : [{ channel: "ntfy", ok: true }];
    },
  };
  return { ...memory, notifications, requests, settings, run: (overrides = {}) => run({ ...deps, ...overrides }) };
}

const realtime = { enabled: true, realtime: true, leadHours: 1, digest: { enabled: false, hourLocal: 7 } };
const digest = { enabled: true, realtime: false, leadHours: 1, digest: { enabled: true, hourLocal: 7 } };

test("checker writes fixture output, calendar, and state through the injected filesystem", async () => {
  const h = makeHarness();
  const { changed, data } = await h.run();
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(h.store.get(OUTPUT)), data);
  assert.equal(data.generatedAt, new Date((fixture.hourly.time[0] + HOUR) * 1000).toISOString());
  assert.equal(data.lastRunDate, data.generatedAt.slice(0, 10));
  assert.deepEqual(data.location, BASE_CONFIG.location);
  assert.equal(data.timezone, "America/New_York");
  assert.ok(Number.isFinite(data.limitC));
  assert.ok(data.windows.length > 0);
  assert.ok(data.hours.length > 0);
  assert.equal(typeof data.status.openNow, "boolean");
  assert.deepEqual(JSON.parse(h.store.get(CHECK_STATUS)), {
    checkedAt: data.generatedAt, generatedAt: data.generatedAt,
  });
  assert.deepEqual(h.renames.map(({ to }) => to), [CALENDAR, OUTPUT, CHECK_STATUS, STATE]);
  assert.deepEqual(h.directories, [
    ...Array.from({ length: 3 }, () => ({ directory: path.dirname(OUTPUT), options: { recursive: true } })),
    { directory: path.dirname(STATE), options: { recursive: true } },
  ]);
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].options.signal instanceof AbortSignal);
  assert.equal(h.notifications.length, 0);
});

test("identical same-day forecast does not perform a second JSON write", async () => {
  const h = makeHarness();
  await h.run();
  const first = h.store.get(OUTPUT);
  const second = await h.run();
  assert.equal(second.changed, false);
  assert.equal(h.store.get(OUTPUT), first);
  assert.equal(h.renames.filter(({ to }) => to === OUTPUT).length, 1);
});

test("a later successful check refreshes only check status when forecast and feed are unchanged", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 4]) });
  const firstTime = START - 8 * HOUR;
  await h.run({ now: firstTime });
  const firstJson = h.store.get(OUTPUT);
  const firstIcs = h.store.get(CALENDAR);
  const firstStatus = JSON.parse(h.store.get(CHECK_STATUS));
  const second = await h.run({ now: firstTime + 7 * HOUR });
  const laterStatus = JSON.parse(h.store.get(CHECK_STATUS));
  assert.equal(second.changed, false);
  assert.equal(second.data.generatedAt, firstStatus.generatedAt);
  assert.equal(h.store.get(OUTPUT), firstJson);
  assert.equal(h.store.get(CALENDAR), firstIcs);
  assert.equal(laterStatus.generatedAt, firstStatus.generatedAt);
  assert.equal(laterStatus.checkedAt, new Date((firstTime + 7 * HOUR) * 1000).toISOString());
  assert.equal(h.renames.filter(({ to }) => to === OUTPUT).length, 1);
  assert.equal(h.renames.filter(({ to }) => to === CALENDAR).length, 1);
  assert.equal(h.renames.filter(({ to }) => to === CHECK_STATUS).length, 2);
});

test("a new lastRunDate performs the daily JSON keepalive write", async () => {
  const h = makeHarness();
  await h.run();
  const previous = JSON.parse(h.store.get(OUTPUT));
  previous.lastRunDate = "2000-01-01";
  h.store.set(OUTPUT, JSON.stringify(previous));
  assert.equal((await h.run()).changed, true);
  assert.equal(h.renames.filter(({ to }) => to === OUTPUT).length, 2);
});

test("injected environment overrides settings without modifying caller configuration", async () => {
  const h = makeHarness({ env: { OW_LAT: "40", OW_LON: "-73", OW_TARGET_RH: "55", OW_DAYS: "2" } });
  const before = structuredClone(h.settings);
  const { data } = await h.run();
  const query = new URL(h.requests[0].url).searchParams;
  assert.equal(query.get("latitude"), "40");
  assert.equal(query.get("longitude"), "-73");
  assert.equal(query.get("forecast_days"), "2");
  assert.deepEqual(data.location, { ...BASE_CONFIG.location, lat: 40, lon: -73 });
  assert.deepEqual(h.settings, before);
});

test("invalid checker configuration is rejected before forecast, file access, or notifications", async () => {
  for (const [config, field] of [
    [{ location: null }, "location"],
    [{ targetRH: 90 }, "targetRH"],
    [{ minOutdoorC: 30, maxOutdoorC: 20 }, "minOutdoorC"],
    [{ forecastDays: 17 }, "forecastDays"],
    [{ indoorReading: { tempC: 20 } }, "indoorReading.rh"],
    [{ notify: { ...realtime, leadHours: -1 } }, "notify.leadHours"],
  ]) {
    const h = makeHarness({ config: { notify: realtime, ...config } });
    await assert.rejects(h.run({ now: START - HOUR / 2 }), (error) => {
      assert.match(error.message, /^Invalid checker settings: /);
      assert.ok(error.message.includes(field), error.message);
      return true;
    });
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.directories, []);
    assert.deepEqual(h.notifications, []);
  }
});

test("blank and malformed numeric environment overrides fail without side effects", async () => {
  for (const key of ["OW_LAT", "OW_LON", "OW_INDOOR_C", "OW_TARGET_RH", "OW_SURFACE_C", "OW_MARGIN_C", "OW_DAYS"]) {
    for (const value of ["", "  ", "12garbage", "Infinity", "NaN", "0x10"]) {
      const h = makeHarness({ env: { [key]: value }, config: { notify: realtime } });
      await assert.rejects(h.run({ now: START - HOUR / 2 }), /Invalid checker settings: /, `${key}=${JSON.stringify(value)}`);
      assert.deepEqual(h.requests, []);
      assert.deepEqual(h.reads, []);
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.directories, []);
      assert.deepEqual(h.notifications, []);
    }
  }
});

test("valid zero and decimal environment values preserve their physical meaning", async () => {
  const h = makeHarness({ env: {
    OW_LAT: "0", OW_LON: "0", OW_INDOOR_C: "0", OW_SURFACE_C: "0",
    OW_MARGIN_C: "0", OW_TARGET_RH: "2e1", OW_DAYS: " +2 ",
  } });
  const { data } = await h.run();
  assert.equal(data.location.lat, 0);
  assert.equal(data.location.lon, 0);
  assert.equal(new URL(h.requests[0].url).searchParams.get("forecast_days"), "2");
  assert.ok(data.limitC < -15, "0°C at 20% RH must yield the colder humidity limit");
});

test("environment overrides may repair invalid config values before validation", async () => {
  const h = makeHarness({ config: { targetRH: 90, forecastDays: 17 }, env: { OW_TARGET_RH: "55", OW_DAYS: "2" } });
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.settings.targetRH, 90);
  assert.equal(h.settings.forecastDays, 17);
});

test("realtime opening alert sends once and records the actual upcoming window", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: realtime } });
  const { data } = await h.run({ now: START - HOUR / 2 });
  assert.equal(data.windows[0].start, START);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "Open the windows");
  assert.match(h.notifications[0].body, /^OK from /);
  assert.equal(h.notifications[0].tags, "window,droplet");
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered[`open:${START}`]), ["ntfy"]);
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 1);
});

test("injected environment controls output, state, and calendar paths", async () => {
  const env = {
    OW_OUTPUT: "/virtual/custom/forecast.json",
    OW_STATE: "/virtual/private/state.json",
    OW_ICS: "/virtual/custom/calendar.ics",
  };
  const h = makeHarness({ env });
  await h.run({ output: undefined, stateFile: undefined });
  assert.deepEqual(h.renames.map(({ to }) => to), [env.OW_ICS, env.OW_OUTPUT,
    "/virtual/custom/check-status.json", env.OW_STATE]);
});

test("OW_OUTPUT alone derives the calendar and check marker beside the final JSON path", async () => {
  const h = makeHarness({ env: { OW_OUTPUT: "/virtual/custom/forecast.json" } });
  await h.run({ output: undefined });
  assert.deepEqual(h.renames.map(({ to }) => to), [
    "/virtual/custom/forecast.ics", "/virtual/custom/forecast.json",
    "/virtual/custom/check-status.json", STATE,
  ]);
});

test("an explicit calendar override wins over an injected output path", async () => {
  const h = makeHarness({ env: { OW_ICS: "/virtual/calendar/feed.ics" } });
  await h.run({ output: "/virtual/custom/forecast.json" });
  assert.deepEqual(h.renames.map(({ to }) => to), [
    "/virtual/calendar/feed.ics", "/virtual/custom/forecast.json",
    "/virtual/custom/check-status.json", STATE,
  ]);
});

test("checker rejects canonical output collisions and public state before fetching", async () => {
  for (const [env, overrides] of [
    [{ OW_ICS: "/virtual/openwindow/sub/../windows.json" }, { output: OUTPUT }],
    [{ OW_CHECK_STATUS: "/virtual/openwindow/./windows.json" }, { output: OUTPUT }],
    [{ OW_STATE: "/virtual/openwindow/sub/../state.json" }, { output: OUTPUT, stateFile: undefined }],
    [{ OW_OUTPUT: "/virtual/openwindow/forecast.txt" }, { output: undefined }],
  ]) {
    const h = makeHarness({ env });
    await assert.rejects(h.run(overrides),
      /checker path|output path|state path/i, JSON.stringify(env));
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.writes, []);
  }
});

test("checker rejects a private-state symlink into the served public tree before fetching", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ow-state-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(fileURLToPath(new URL("../public/data", import.meta.url)),
    path.join(directory, "private"));
  let requests = 0;
  await assert.rejects(run({
    config: structuredClone(BASE_CONFIG), env: {},
    output: path.join(directory, "output", "windows.json"),
    stateFile: path.join(directory, "private", "state.json"),
    fetchImpl: async () => { requests++; throw new Error("Unexpected forecast request"); },
  }), /state path must be outside/);
  assert.equal(requests, 0);
});

test("realtime disabled suppresses an otherwise eligible opening alert", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: { ...realtime, realtime: false } } });
  const { data } = await h.run({ now: START - HOUR / 2 });
  assert.equal(data.windows[0].start, START);
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {});
});

test("disabled notifications suppress both an eligible realtime alert and digest", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: { ...digest, enabled: false, realtime: true } } });
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {});
});

test("opening alerts wait until their configured lead interval", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: realtime } });
  await h.run({ now: START - 2 * HOUR });
  assert.equal(h.notifications.length, 0);
  await h.run({ now: START - HOUR });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "Open the windows");
});

test("realtime closing alert sends once for a qualifying current window", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4]), config: { notify: { ...realtime, leadHours: 2 } } });
  await h.run({ now: START });
  assert.equal(h.notifications.filter(({ title }) => title === "Close the windows").length, 1);
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered[`close:${START}:${START + 2 * HOUR}`]), ["ntfy"]);
  await h.run({ now: START });
  assert.equal(h.notifications.filter(({ title }) => title === "Close the windows").length, 1);
});

test("checker keeps an ongoing window through its final second with stable identity and remaining time", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 4, 20]) });
  const end = START + 3 * HOUR;
  for (const offset of [HOUR / 2, HOUR, 2 * HOUR, 3 * HOUR - 1]) {
    const { data } = await h.run({ now: START + offset });
    assert.equal(data.status.openNow, true, `offset ${offset}`);
    assert.deepEqual(data.status.reasons, []);
    assert.equal(data.status.currentWindow.start, START);
    assert.equal(data.status.currentWindow.end, end);
    assert.equal(data.status.currentWindow.hours, 3);
    assert.equal(data.status.closesAt, end);
    assert.equal(data.status.remainingSeconds, end - START - offset);
    assert.deepEqual(data.windows, [data.status.currentWindow]);
    assert.equal(data.hours[0].t, START + Math.floor(offset / HOUR) * HOUR);
    assert.ok(data.hours.every((hour) => hour.t + HOUR > START + offset));
  }
  const { data } = await h.run({ now: end });
  assert.equal(data.status.openNow, false);
  assert.deepEqual(data.status.reasons, ["DEW_TOO_HIGH"]);
  assert.equal(data.status.currentWindow, null);
  assert.equal(data.status.closesAt, null);
  assert.equal(data.status.remainingSeconds, null);
  assert.deepEqual(data.windows, []);
});

test("background artifact retains normalized pre-now history for later browser replanning", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 4, 4, 20]) });
  const { data } = await h.run({ now: START + HOUR + HOUR / 2 });
  const published = JSON.parse(h.store.get(OUTPUT));
  assert.deepEqual(published.forecastHours, data.forecastHours);
  assert.deepEqual(data.forecastHours.map(({ t }) => t), Array.from({ length: 5 }, (_, i) => START + i * HOUR));
  assert.deepEqual(Object.keys(data.forecastHours[0]), [
    "t", "tempC", "dewPointC", "rh", "precipProb", "precipMm", "windKmh",
  ]);
  assert.equal(data.hours[0].t, START + HOUR, "display hours may discard earlier observations");

  const later = planForecast(published.forecastHours, h.settings, START + 2 * HOUR + HOUR / 2);
  assert.equal(later.status.openNow, true);
  assert.equal(later.status.currentWindow.start, START);
  assert.equal(later.status.currentWindow.end, START + 4 * HOUR);
  assert.equal(later.status.currentWindow.hours, 4);
});

test("realtime alerts retain one opening and one final-hour closing across checker passes", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 4, 20]), config: { notify: realtime } });
  for (const offset of [-HOUR / 2, HOUR / 2, HOUR]) {
    await h.run({ now: START + offset });
    assert.deepEqual(h.notifications.map(({ title }) => title), ["Open the windows"]);
  }
  for (const offset of [2 * HOUR, 2.5 * HOUR, 3 * HOUR - 1, 3 * HOUR]) {
    await h.run({ now: START + offset });
    assert.deepEqual(h.notifications.map(({ title }) => title), ["Open the windows", "Close the windows"]);
  }
  const state = JSON.parse(h.store.get(STATE));
  assert.deepEqual(Object.keys(state.delivered[`open:${START}`]), ["ntfy"]);
  assert.deepEqual(Object.keys(state.delivered[`close:${START}:${START + 3 * HOUR}`]), ["ntfy"]);
});

test("an hour missing outdoor temperature breaks a checker window and reports NO_DATA", async () => {
  const forecast = makeForecast([4, 4, 4, 4]);
  forecast.hourly.temperature_2m[1] = null;
  const h = makeHarness({ forecast });
  const { data } = await h.run({ now: START + HOUR + HOUR / 2 });
  assert.equal(data.status.openNow, false);
  assert.deepEqual(data.status.reasons, ["NO_DATA"]);
  assert.equal(data.hours[0].tempC, null);
  assert.equal(data.hours[0].ok, false);
  assert.deepEqual(data.hours[0].reasons, ["NO_DATA"]);
  assert.equal(data.hours[0].predictedIndoorRH, null);
  assert.equal(data.windows.length, 1);
  assert.equal(data.windows[0].start, START + 2 * HOUR);
  assert.equal(data.windows[0].end, START + 4 * HOUR);
  assert.equal(data.windows[0].hours, 2);
  assert.deepEqual(data.status.nextWindow, data.windows[0]);
});

test("an actually invoked throwing notifier is logged without failing the checker", async () => {
  const errors = mock.method(console, "error", () => {});
  const h = makeHarness({
    forecast: makeForecast(), config: { notify: realtime },
    notifyImpl: async () => { throw new Error("fixture notification failure"); },
  });
  const result = await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "Open the windows");
  assert.equal(result.changed, true);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[0], /fixture notification failure/);
});

test("an HTTP failure reported by the notifier does not fail forecast output", async () => {
  const h = makeHarness({
    forecast: makeForecast(), config: { notify: realtime },
    notifyImpl: async () => [{ channel: "ntfy", ok: false, error: "HTTP 503" }],
  });
  const { data } = await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(JSON.parse(h.store.get(OUTPUT)), data);
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {});
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 2, "a failed delivery remains pending");
});

test("partial notification failure retries only the failed channel", async () => {
  const attempts = [];
  const h = makeHarness({
    forecast: makeForecast(), config: { notify: realtime },
    env: { DISCORD_WEBHOOK_URL: "https://example.invalid/hook" },
    notifyImpl: async (_message, { channels }) => {
      attempts.push(channels);
      return channels.map((channel) => ({ channel, ok: channel === "ntfy" || attempts.length > 1 }));
    },
  });
  const at = START - HOUR / 2;
  await h.run({ now: at });
  await h.run({ now: at });
  await h.run({ now: at });
  assert.deepEqual(attempts, [["ntfy", "discord"], ["discord"]]);
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered[`open:${START}`]).sort(), ["discord", "ntfy"]);
});

test("a skipped result is retried and a changed destination receives the event", async () => {
  let calls = 0;
  const h = makeHarness({ forecast: makeForecast(), config: { notify: realtime },
    notifyImpl: async () => {
      calls++;
      return calls === 1 ? [{ channel: "ntfy", ok: false, skipped: true }]
        : [{ channel: "ntfy", ok: true }];
    } });
  const at = START - HOUR / 2;
  await h.run({ now: at });
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {});
  await h.run({ now: at });
  await h.run({ now: at });
  assert.equal(calls, 2);
  await h.run({ now: at, env: { NTFY_TOPIC: "different-topic" } });
  assert.equal(calls, 3, "a new destination has no confirmed delivery");
});

test("unconfigured and skipped channels never consume an event", async () => {
  const attempts = [];
  const h = makeHarness({ forecast: makeForecast(), config: { notify: realtime },
    env: { NTFY_TOPIC: "" },
    notifyImpl: async (_message, { channels }) => { attempts.push(channels); return []; } });
  await h.run({ now: START - HOUR / 2 });
  assert.deepEqual(attempts, []);
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {});
  await h.run({ now: START - HOUR / 2, env: { NTFY_TOPIC: "new-topic" } });
  assert.deepEqual(attempts, [["ntfy"]]);
  assert.deepEqual(JSON.parse(h.store.get(STATE)).delivered, {}, "no result does not prove delivery");
});

test("legacy aggregate notification markers are retried and replaced with v2 state", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: realtime } });
  h.store.set(STATE, JSON.stringify({ notifiedStarts: [String(START)], notifiedEnds: [], digestSentDate: "2026-09-16" }));
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 1);
  const state = JSON.parse(h.store.get(STATE));
  assert.equal(state.version, 2);
  assert.deepEqual(Object.keys(state.delivered[`open:${START}`]), ["ntfy"]);
  assert.equal(Object.hasOwn(state, "notifiedStarts"), false);
});

test("zero lead time does not send opening alerts before the window starts", async () => {
  const h = makeHarness({ forecast: makeForecast(), config: { notify: { ...realtime, leadHours: 0 } } });
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 0);
  await h.run({ now: START });
  assert.deepEqual(h.notifications.map(({ title }) => title), ["Open the windows"]);
  assert.match(h.notifications[0].body, /UTC/);
});

test("digest sends once per local date even across a UTC date boundary", async () => {
  const h = makeHarness({ config: { notify: digest } });
  const now = fixture.hourly.time[0] + 19 * HOUR;
  const localDate = (time) => new Intl.DateTimeFormat("en-CA", { timeZone: fixture.timezone }).format(new Date(time * 1000));
  assert.notEqual(new Date(now * 1000).getUTCDate(), new Date((now + 2 * HOUR) * 1000).getUTCDate());
  assert.equal(localDate(now), localDate(now + 2 * HOUR));
  await h.run({ now });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "OpenWindow daily digest");
  assert.match(h.notifications[0].body, /dew point/);
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered[`digest:${localDate(now)}`]), ["ntfy"]);
  await h.run({ now: now + 2 * HOUR });
  assert.equal(h.notifications.length, 1);
  await h.run({ now: now + 24 * HOUR });
  assert.equal(h.notifications.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered[`digest:${localDate(now + 24 * HOUR)}`]), ["ntfy"]);
});

test("digest waits for its configured local hour", async () => {
  const h = makeHarness({ config: { notify: digest } });
  await h.run({ now: fixture.hourly.time[0] + 6 * HOUR });
  assert.equal(h.notifications.length, 0);
  await h.run({ now: fixture.hourly.time[0] + 7 * HOUR });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "OpenWindow daily digest");
});

test("digest with no suitable windows sends the no-window message", async () => {
  const h = makeHarness({ forecast: makeForecast([20, 20, 20]), config: { notify: digest } });
  const { data } = await h.run({ now: START - HOUR / 2 });
  assert.deepEqual(data.windows, []);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, "OpenWindow daily digest");
  assert.match(h.notifications[0].body, /^No suitable window before .*9:00 AM UTC\. No further window forecast\.$/);
  await h.run({ now: START - HOUR / 2 });
  assert.equal(h.notifications.length, 1);
});

test("digest stops at tomorrow 09:00 in the forecast timezone across spring DST", async () => {
  const start = Math.floor(Date.parse("2026-03-07T14:00:00Z") / 1000);
  const now = Math.floor(Date.parse("2026-03-07T15:00:00Z") / 1000);
  const beforeCutoff = Math.floor(Date.parse("2026-03-08T10:00:00Z") / 1000);
  const atCutoff = Math.floor(Date.parse("2026-03-08T13:00:00Z") / 1000);
  const dews = Array.from({ length: 27 }, (_, i) => {
    const t = start + i * HOUR;
    return (t === beforeCutoff || t === beforeCutoff + HOUR || t === atCutoff || t === atCutoff + HOUR) ? 4 : 20;
  });
  const forecast = makeForecast(dews);
  forecast.timezone = "America/New_York";
  forecast.hourly.time = dews.map((_, i) => start + i * HOUR);
  const h = makeHarness({ forecast, config: { notify: digest } });
  await h.run({ now });
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /6:00 AM EDT/);
  assert.doesNotMatch(h.notifications[0].body, /9:00 AM EDT/);
});

test("digest cutoff and message timezone remain correct across fall DST", async () => {
  const start = Math.floor(Date.parse("2026-10-31T13:00:00Z") / 1000);
  const now = Math.floor(Date.parse("2026-10-31T14:00:00Z") / 1000);
  const beforeCutoff = Math.floor(Date.parse("2026-11-01T11:00:00Z") / 1000);
  const atCutoff = Math.floor(Date.parse("2026-11-01T14:00:00Z") / 1000);
  const dews = Array.from({ length: 27 }, (_, i) => {
    const t = start + i * HOUR;
    return (t === beforeCutoff || t === beforeCutoff + HOUR || t === atCutoff || t === atCutoff + HOUR) ? 4 : 20;
  });
  const forecast = makeForecast(dews);
  forecast.timezone = "America/New_York";
  forecast.hourly.time = dews.map((_, i) => start + i * HOUR);
  const h = makeHarness({ forecast, config: { notify: digest } });
  await h.run({ now });
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /6:00 AM EST/);
  assert.doesNotMatch(h.notifications[0].body, /9:00 AM EST/);
});

test("a digest delayed past its configured local hour still sends once", async () => {
  const h = makeHarness({ config: { notify: { ...digest, digest: { enabled: true, hourLocal: 7 } } } });
  const now = fixture.hourly.time[0] + 10 * HOUR;
  await h.run({ now });
  await h.run({ now: now + HOUR });
  assert.deepEqual(h.notifications.map(({ title }) => title), ["OpenWindow daily digest"]);
});

test("a delayed digest includes a suitable window already in progress", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 20]), config: { notify: digest } });
  await h.run({ now: START + HOUR / 2 });
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /lowest forecast dew point/);
  assert.doesNotMatch(h.notifications[0].body, /No suitable window/);
});

test("forecast fetch failure rejects without writing files or sending notifications", async () => {
  const h = makeHarness({ config: { notify: realtime } });
  let fetchCalls = 0;
  await assert.rejects(h.run({ fetchImpl: async () => { fetchCalls++; throw new Error("fixture network down"); } }), /fixture network down/);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.directories, []);
  assert.equal(h.notifications.length, 0);
});

test("malformed forecast payloads preserve previous artifacts without file access or notifications", async () => {
  const duplicate = makeForecast();
  duplicate.hourly.time[1] = duplicate.hourly.time[0];
  const missing = makeForecast();
  missing.hourly.temperature_2m.fill(null);
  missing.hourly.dew_point_2m.fill(null);
  const invalidTimezone = { ...makeForecast(), timezone: "Invalid/Fixture_Zone" };
  for (const forecast of [duplicate, missing, invalidTimezone]) {
    const h = makeHarness({ forecast, config: { notify: realtime } });
    h.store.set(OUTPUT, "previous good forecast");
    h.store.set(CALENDAR, "previous good calendar");
    h.store.set(STATE, "previous notification state");
    const previous = new Map(h.store);
    await assert.rejects(h.run({ now: START - HOUR / 2 }), /Invalid forecast/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.directories, []);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.store, previous);
  }
});

test("forecasts with no usable current or future hours preserve previous output and notification state", async () => {
  const historicalOnly = makeForecast();
  historicalOnly.hourly.temperature_2m = [18, null, null];
  for (const [forecast, now] of [
    [makeForecast(), START + 3 * HOUR],
    [historicalOnly, START + HOUR],
  ]) {
    const h = makeHarness({ forecast, config: { notify: realtime } });
    h.store.set(OUTPUT, "previous good forecast");
    h.store.set(CALENDAR, "previous good calendar");
    h.store.set(STATE, "previous notification state");
    const previous = new Map(h.store);
    await assert.rejects(h.run({ now }), /no usable current or future hours/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.reads, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.directories, []);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.store, previous);
  }
});

test("injected output write failure rejects before notifications or later writes", async () => {
  const h = makeHarness({ memory: makeMemoryFs({ failWrite: OUTPUT }), config: { notify: realtime } });
  await assert.rejects(h.run({ now: START - HOUR / 2 }), /mock write failure/);
  assert.deepEqual(h.writes.map(({ file }) => file.endsWith(".tmp")), [true, true]);
  assert.deepEqual(h.renames, []);
  assert.equal(h.store.size, 0);
  assert.equal(h.notifications.length, 0);
});

test("a later artifact staging or rename failure preserves both previous public files", async () => {
  const initial = makeHarness({ forecast: makeForecast([4, 4, 4]) });
  await initial.run({ now: START - HOUR / 2 });
  for (const failure of [{ failWrite: OUTPUT }, { failRename: OUTPUT }]) {
    const memory = makeMemoryFs(failure);
    for (const [file, content] of initial.store) memory.store.set(file, content);
    const before = new Map(memory.store);
    const h = makeHarness({ forecast: makeForecast([3, 3, 3]), memory, config: { notify: realtime } });
    await assert.rejects(h.run({ now: START - HOUR / 2 }), /mock (?:write|rename) failure/);
    assert.deepEqual(h.store, before);
    assert.deepEqual(h.notifications, []);
    assert.equal([...h.store.keys()].some((file) => file.endsWith(".tmp") || file.endsWith(".bak")), false);
  }
});

test("check-status staging or rename failure rolls back forecast and calendar together", async () => {
  const initial = makeHarness({ forecast: makeForecast([4, 4, 4]) });
  await initial.run({ now: START - HOUR / 2 });
  for (const failure of [{ failWrite: CHECK_STATUS }, { failRename: CHECK_STATUS }]) {
    const memory = makeMemoryFs(failure);
    for (const [file, content] of initial.store) memory.store.set(file, content);
    const before = new Map(memory.store);
    const h = makeHarness({ forecast: makeForecast([3, 3, 3]), memory,
      config: { notify: realtime } });
    await assert.rejects(h.run({ now: START - HOUR / 2 + 60 }), /mock (?:write|rename) failure/);
    assert.deepEqual(h.store, before);
    assert.deepEqual(h.notifications, []);
    assert.equal([...h.store.keys()].some((file) => file.endsWith(".tmp") || file.endsWith(".bak")), false);
  }
});

test("confirmed opening state survives a later closing-state write failure", async () => {
  const memory = makeMemoryFs();
  const write = memory.fs.writeFile;
  let stateStages = 0;
  memory.fs.writeFile = async (file, content) => {
    if (file.startsWith(`${STATE}.`) && file.endsWith(".tmp") && ++stateStages === 2) {
      throw new Error("second state write failed");
    }
    return write(file, content);
  };
  const h = makeHarness({ forecast: makeForecast([4, 4]), memory,
    config: { notify: { ...realtime, leadHours: 2 } } });
  await assert.rejects(h.run({ now: START }), /second state write failed/);
  assert.deepEqual(h.notifications.map(({ title }) => title), ["Open the windows", "Close the windows"]);
  assert.deepEqual(Object.keys(JSON.parse(h.store.get(STATE)).delivered), [`open:${START}`]);
  await h.run({ now: START });
  assert.deepEqual(h.notifications.map(({ title }) => title), ["Open the windows", "Close the windows", "Close the windows"]);
});

test("injected directory failure propagates without any writes", async () => {
  const h = makeHarness({ memory: makeMemoryFs({ failMkdir: true }) });
  await assert.rejects(h.run(), /mock directory failure/);
  assert.equal(h.directories.length, 1);
  assert.deepEqual(h.writes, []);
});

test("an atomic virtual filesystem may omit mkdir without touching real directories", async () => {
  const h = makeHarness();
  const fs = { readFile: h.fs.readFile, writeFile: h.fs.writeFile,
    rename: h.fs.rename, unlink: h.fs.unlink };
  await h.run({ fs });
  assert.equal(h.store.size, 4);
  assert.deepEqual(h.directories, []);
});

test("default filesystem creates nested output directories inside an isolated temp directory", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ow-check-test-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const output = path.join(tmp, "public", "windows.json");
  const stateFile = path.join(tmp, "private", "state.json");
  const h = makeHarness();
  const { data } = await h.run({ fs: undefined, output, stateFile });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), data);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).delivered, {});
  assert.match(await readFile(path.join(tmp, "public", "windows.ics"), "utf8"), /BEGIN:VEVENT/);
  assert.equal(h.notifications.length, 0);
});

test("calendar has CRLF lines, UTF-8 byte limits, alarms, and stable UIDs", async () => {
  const h = makeHarness();
  const { data } = await h.run();
  const ics = h.store.get(CALENDAR);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[\r\n]/.test(ics.replaceAll("\r\n", "")), "no bare CR or LF line endings");
  assert.match(ics, /X-WR-CALNAME:Open Windows\r\n/);
  assert.match(ics, /X-PUBLISHED-TTL:PT1H\r\n/);
  for (const line of ics.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `calendar line exceeds 75 bytes: ${line}`);
  }
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, data.windows.length);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, data.windows.length);
  assert.match(ics, /TRIGGER:-PT15M\r\n/);
  const uids = (text) => [...text.matchAll(/^UID:(.+)$/gm)].map((match) => match[1]);
  const first = uids(ics);
  assert.equal(first.length, data.windows.length);
  assert.ok(first.every(Boolean));
  assert.equal(new Set(first).size, first.length);
  await h.run();
  assert.deepEqual(uids(h.store.get(CALENDAR)), first);
});

test("unchanged windows keep calendar bytes and JSON stable despite a later countdown", async () => {
  const h = makeHarness({ forecast: makeForecast([4, 4, 4, 20]) });
  await h.run({ now: START + HOUR / 2 });
  const firstJson = h.store.get(OUTPUT);
  const firstIcs = h.store.get(CALENDAR);
  const later = await h.run({ now: START + HOUR / 2 + 600 });
  assert.equal(later.changed, false);
  assert.equal(h.store.get(OUTPUT), firstJson);
  assert.equal(h.store.get(CALENDAR), firstIcs);
  assert.equal(h.renames.filter(({ to }) => to === OUTPUT).length, 1);
  assert.equal(h.renames.filter(({ to }) => to === CALENDAR).length, 1);
  assert.equal(h.renames.filter(({ to }) => to === STATE).length, 2);
});
