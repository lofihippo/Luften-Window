import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSettings, validate, toQuery, fromQuery } from "../public/core/settings.js";
import { computeLimitC, evaluateHours, groupWindows } from "../public/core/windows.js";

const DEFAULTS = {
  location: { lat: 40.7128, lon: -74.0060, label: "Home" },
  units: "F",
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
  forecastDays: 3,
  notify: { enabled: true, leadHours: 1, realtime: false, digest: { enabled: true, hourLocal: 7 } },
};
const parse = (query) => fromQuery(new URLSearchParams(query));
const atPath = (value, path) => path.split(".").reduce((item, key) => item[key], value);
function withField(path, value) {
  const settings = mergeSettings(DEFAULTS);
  const keys = path.split(".");
  let target = settings;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
  return settings;
}
function assertInvalid(settings, path) {
  const result = validate(settings);
  assert.equal(result.ok, false, `${path} should be invalid`);
  assert.equal(typeof result.fieldErrors[path], "string", `missing field error: ${path}`);
  assert.ok(result.errors.includes(result.fieldErrors[path]));
  return result;
}

const NUMERIC_FIELDS = [
  "location.lat", "location.lon", "indoorTempC", "targetRH", "coldestSurfaceC", "marginC",
  "minOutdoorC", "maxOutdoorC", "maxRainProb", "maxWindKmh", "minWindowHours", "forecastDays",
  "indoorReading.tempC", "indoorReading.rh", "notify.leadHours", "notify.digest.hourLocal",
];

test("complete shipped defaults validate and empty URL preserves them", () => {
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse("unrelated=value"), {});
  const merged = mergeSettings(DEFAULTS, parse(""));
  assert.deepEqual(merged, DEFAULTS);
  assert.deepEqual(validate(merged), { ok: true, errors: [], fieldErrors: {} });
});

test("partial URLs preserve defaults < stored settings < URL precedence", () => {
  const stored = { indoorTempC: 18, location: { lat: 40, label: "Stored" }, maxRainProb: 42 };
  const query = parse("it=19&rh=55&lon=0");
  assert.deepEqual(query, { indoorTempC: 19, targetRH: 55, location: { lon: 0 } });
  const merged = mergeSettings(DEFAULTS, stored, query);
  assert.equal(merged.indoorTempC, 19);
  assert.equal(merged.targetRH, 55);
  assert.deepEqual(merged.location, { lat: 40, lon: 0, label: "Stored" });
  assert.equal(merged.maxRainProb, 42);
  assert.equal(merged.marginC, DEFAULTS.marginC);
  assert.equal(validate(merged).ok, true);
});

test("merging returns independent objects even without overrides", () => {
  const defaultsCopy = structuredClone(DEFAULTS);
  const overrides = { location: { label: "Office" }, notify: { digest: { hourLocal: 9 } } };
  const overridesCopy = structuredClone(overrides);
  const merged = mergeSettings(DEFAULTS, overrides);
  merged.location.label = "Changed";
  merged.notify.digest.hourLocal = 12;
  const onlyDefaults = mergeSettings(DEFAULTS);
  onlyDefaults.location.lat = 0;
  onlyDefaults.notify.digest.enabled = false;
  assert.deepEqual(DEFAULTS, defaultsCopy);
  assert.deepEqual(overrides, overridesCopy);
});

test("corrupt stored roots are ignored while malformed nested values remain invalid", () => {
  for (const stored of [null, false, true, 1, "settings", [], [DEFAULTS], new Date(), () => {}]) {
    assert.deepEqual(mergeSettings(DEFAULTS, stored), DEFAULTS);
  }
  for (const stored of [{ location: null }, { location: "Home" }, { location: [] }]) {
    assertInvalid(mergeSettings(DEFAULTS, stored), "location");
  }
  assertInvalid(mergeSettings(DEFAULTS, { indoorReading: [] }), "indoorReading");
  assert.equal(mergeSettings(DEFAULTS, { indoorTempC: undefined }).indoorTempC, DEFAULTS.indoorTempC);
});

test("plain null-prototype settings merge safely and prototype keys are discarded recursively", () => {
  const stored = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"location":{"lat":0,"__proto__":{"polluted":true}},"notify":{"digest":{"constructor":{"prototype":{"polluted":true}}}}}');
  const nullPrototype = Object.assign(Object.create(null), { targetRH: 60 });
  const merged = mergeSettings(DEFAULTS, stored, nullPrototype);
  assert.equal(merged.location.lat, 0);
  assert.equal(merged.targetRH, 60);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.hasOwn(merged, "__proto__"), false);
  assert.equal(Object.hasOwn(merged, "constructor"), false);
  assert.equal(Object.hasOwn(merged.location, "__proto__"), false);
  assert.equal(Object.hasOwn(merged.notify.digest, "constructor"), false);
  assert.equal({}.polluted, undefined);
  assert.equal(validate(merged).ok, true);
});

test("validation rejects malformed roots and containers without throwing", () => {
  for (const root of [null, undefined, true, 3, "", [], new Date(), () => {}]) {
    assertInvalid(root, "settings");
  }
  for (const shape of [null, false, 3, "object", [], new Date()]) {
    assertInvalid({ ...DEFAULTS, location: shape }, "location");
    assertInvalid({ ...DEFAULTS, notify: shape }, "notify");
    assertInvalid({ ...DEFAULTS, notify: { ...DEFAULTS.notify, digest: shape } }, "notify.digest");
    if (shape !== null) assertInvalid({ ...DEFAULTS, indoorReading: shape }, "indoorReading");
  }
});

test("each calculation/request/notification number rejects coercion and non-finite values", () => {
  for (const path of NUMERIC_FIELDS) {
    for (const value of ["30", "", true, false, NaN, Infinity, -Infinity, [], {}]) {
      assertInvalid(withField(path, value), path);
    }
    if (path !== "coldestSurfaceC") assertInvalid(withField(path, null), path);
  }
});

test("required calculation fields cannot be missing", () => {
  for (const path of NUMERIC_FIELDS.filter((path) => path !== "coldestSurfaceC")) {
    assertInvalid(withField(path, undefined), path);
  }
  assertInvalid(withField("requireDrying", undefined), "requireDrying");
  assertInvalid(withField("units", undefined), "units");
});

test("numeric ranges reject finite but unsafe values", () => {
  const badValues = {
    "location.lat": [-90.01, 90.01], "location.lon": [-180.01, 180.01],
    indoorTempC: [-100.01, 100.01], coldestSurfaceC: [-100.01, 100.01],
    minOutdoorC: [-100.01, 100.01], maxOutdoorC: [-100.01, 100.01],
    targetRH: [19.99, 80.01], marginC: [-0.01], maxRainProb: [-0.01, 100.01],
    maxWindKmh: [-0.01], minWindowHours: [0, -1, 1.5], forecastDays: [0, 17, 3.5],
    "indoorReading.tempC": [-100.01, 100.01], "indoorReading.rh": [0, -1, 100.01],
    "notify.leadHours": [-0.01], "notify.digest.hourLocal": [-1, 24, 7.5],
  };
  for (const [path, values] of Object.entries(badValues)) {
    for (const value of values) assertInvalid(withField(path, value), path);
  }
});

test("allowed boundaries and zero-valued limits remain valid", () => {
  for (const settings of [
    mergeSettings(DEFAULTS, {
      location: { lat: -90, lon: -180, label: "" }, units: "C", indoorTempC: -100,
      coldestSurfaceC: -100, targetRH: 20, marginC: 0, minOutdoorC: -100, maxOutdoorC: 100,
      maxRainProb: 0, maxWindKmh: 0, minWindowHours: 1, forecastDays: 1,
      indoorReading: { tempC: -100, rh: 0.01 }, notify: { leadHours: 0, digest: { hourLocal: 0 } },
    }),
    mergeSettings(DEFAULTS, {
      location: { lat: 90, lon: 180 }, units: "F", indoorTempC: 100,
      coldestSurfaceC: 100, targetRH: 80, maxRainProb: 100, forecastDays: 16,
      indoorReading: { tempC: 100, rh: 100 }, notify: { digest: { hourLocal: 23 } },
    }),
  ]) {
    assert.deepEqual(validate(settings), { ok: true, errors: [], fieldErrors: {} });
  }
});

test("outdoor min must be strictly below max", () => {
  for (const minOutdoorC of [20, 30]) {
    assertInvalid({ ...DEFAULTS, minOutdoorC, maxOutdoorC: 20 }, "minOutdoorC");
  }
});

test("units, booleans, and labels reject coercion", () => {
  for (const units of ["c", "f", "K", "", 0, null]) assertInvalid({ ...DEFAULTS, units }, "units");
  for (const path of ["requireDrying", "notify.enabled", "notify.realtime", "notify.digest.enabled"]) {
    for (const value of ["true", "false", 0, 1, null, [], {}]) assertInvalid(withField(path, value), path);
  }
  for (const value of [null, 1, [], {}]) assertInvalid(withField("location.label", value), "location.label");
});

test("optional readings may be absent with drying enabled; supplied readings must be complete", () => {
  assert.equal(validate({ ...DEFAULTS, requireDrying: true, indoorReading: null }).ok, true);
  for (const indoorReading of [{}, { tempC: 20 }, { rh: 50 }]) {
    assert.equal(validate({ ...DEFAULTS, indoorReading }).ok, false);
  }
  // Disabled drying does not make a malformed stored reading safe to retain.
  assertInvalid({ ...DEFAULTS, requireDrying: false, indoorReading: { tempC: 20, rh: 0 } }, "indoorReading.rh");
});

test("legacy notification configs may omit notify, realtime, and digest", () => {
  const minimal = { ...DEFAULTS };
  delete minimal.notify;
  assert.equal(validate(minimal).ok, true);
  minimal.notify = { enabled: false, leadHours: 0 };
  assert.equal(validate(minimal).ok, true);
  minimal.notify = {};
  assertInvalid(minimal, "notify.enabled");
  assertInvalid(minimal, "notify.leadHours");
});

test("all present invalid numeric URL parameters survive merge as validation errors", () => {
  const keys = {
    lat: "location.lat", lon: "location.lon", it: "indoorTempC", rh: "targetRH", cs: "coldestSurfaceC",
    m: "marginC", mn: "minOutdoorC", mx: "maxOutdoorC", rp: "maxRainProb", w: "maxWindKmh",
    mw: "minWindowHours", fd: "forecastDays", irt: "indoorReading.tempC", irr: "indoorReading.rh",
  };
  for (const [key, path] of Object.entries(keys)) {
    for (const value of ["", " ", "invalid", "NaN", "Infinity", "-Infinity", "0x10", "12garbage", "1e309"]) {
      const params = new URLSearchParams({ [key]: value });
      const parsed = fromQuery(params);
      assert.equal(typeof atPath(parsed, path), "number");
      assertInvalid(mergeSettings(DEFAULTS, parsed), path);
    }
  }
});

test("URL zero remains zero and invalid booleans/enums remain invalid", () => {
  const parsed = parse("lat=0&lon=0&it=0&cs=0&m=0&rp=0&w=0&rd=false");
  const merged = mergeSettings(DEFAULTS, parsed);
  assert.equal(merged.location.lat, 0);
  assert.equal(merged.location.lon, 0);
  assert.equal(merged.indoorTempC, 0);
  assert.equal(merged.coldestSurfaceC, 0);
  assert.equal(merged.requireDrying, false);
  assert.equal(validate(merged).ok, true);
  for (const value of ["", "yes", "0", "1", "TRUE"]) {
    assertInvalid(mergeSettings(DEFAULTS, parse(`rd=${value}`)), "requireDrying");
  }
  assertInvalid(mergeSettings(DEFAULTS, parse("u=Kelvin")), "units");
});

test("partial and ambiguous URL readings cannot silently borrow stored values", () => {
  const stored = { indoorReading: { tempC: 20, rh: 50 } };
  for (const query of ["irt=19", "irr=40", "ir=null&irt=19&irr=40", "ir=invalid&irt=19&irr=40"]) {
    const parsed = mergeSettings(DEFAULTS, stored, parse(query));
    assert.equal(validate(parsed).ok, false, query);
  }
  for (const query of ["ir=", "ir=invalid"]) {
    assertInvalid(mergeSettings(DEFAULTS, stored, parse(query)), "indoorReading");
  }
  assert.deepEqual(parse("irt=19&irr=40"), { indoorReading: { tempC: 19, rh: 40 } });
});

test("share links round-trip every recommendation field and Unicode location labels", () => {
  const settings = mergeSettings(DEFAULTS, {
    location: { lat: 40.5, lon: -73.1, label: "München / Büro & Patio" },
    units: "C", indoorTempC: 19, targetRH: 55, coldestSurfaceC: 6, marginC: 2,
    minOutdoorC: 5, maxOutdoorC: 30, maxRainProb: 25, maxWindKmh: 35, minWindowHours: 3,
    requireDrying: true, indoorReading: { tempC: 20, rh: 45 }, forecastDays: 5,
  });
  const params = new URLSearchParams(toQuery(settings));
  for (const key of ["lat", "lon", "it", "rh", "cs", "m", "mn", "mx", "rp", "w", "mw", "u"]) {
    assert.equal(params.has(key), true, `missing legacy key ${key}`);
  }
  assert.equal(params.get("label"), settings.location.label);
  assert.equal(params.get("rd"), "true");
  assert.equal(params.get("fd"), "5");
  assert.equal(params.has("notify"), false);
  assert.deepEqual(mergeSettings(DEFAULTS, fromQuery(params)), settings);
});

test("explicit false/null/empty label share values clear conflicting stored preferences", () => {
  const sender = mergeSettings(DEFAULTS, { location: { label: "" }, requireDrying: false });
  const params = new URLSearchParams(toQuery(sender));
  assert.equal(params.get("rd"), "false");
  assert.equal(params.get("cs"), "null");
  assert.equal(params.get("ir"), "null");
  assert.equal(params.get("label"), "");
  const stored = { location: { label: "Elsewhere" }, coldestSurfaceC: -10, requireDrying: true, indoorReading: { tempC: 20, rh: 15 } };
  const recipient = mergeSettings(DEFAULTS, stored, fromQuery(params));
  assert.deepEqual(recipient, sender);
  assert.equal(validate(recipient).ok, true);
  assert.deepEqual(parse("cs=null&ir=null"), { coldestSurfaceC: null, indoorReading: null });
});

test("shared limits and windows match on fresh and conflicting-storage recipients", () => {
  const now = 1_800_000_000;
  const hours = [2, 2, 12, 3, 3].map((dewPointC, i) => ({
    t: now + i * 3600, tempC: 15, dewPointC, precipProb: 10, precipMm: 0, windKmh: 5,
  }));
  const stored = {
    location: { lat: -30, lon: 20, label: "Other location" }, units: "C", indoorTempC: 23,
    targetRH: 30, coldestSurfaceC: -10, marginC: 4, minOutdoorC: 20, maxOutdoorC: 24,
    maxRainProb: 0, maxWindKmh: 0, minWindowHours: 4, forecastDays: 1,
    requireDrying: true, indoorReading: { tempC: 20, rh: 10 },
  };
  for (const sender of [
    mergeSettings(DEFAULTS),
    mergeSettings(DEFAULTS, { requireDrying: true, indoorReading: { tempC: 20, rh: 40 }, forecastDays: 7 }),
    mergeSettings(DEFAULTS, { coldestSurfaceC: 6, targetRH: 65, requireDrying: true, indoorReading: null }),
  ]) {
    const expectedLimit = computeLimitC(sender);
    const expectedWindows = groupWindows(evaluateHours(hours, sender, now), sender);
    assert.equal(expectedWindows.length, 2, "fixture must exercise actual windows");
    for (const existing of [{}, stored]) {
      const recipient = mergeSettings(DEFAULTS, existing, parse(toQuery(sender)));
      assert.equal(validate(recipient).ok, true);
      assert.equal(computeLimitC(recipient), expectedLimit);
      assert.deepEqual(groupWindows(evaluateHours(hours, recipient, now), recipient), expectedWindows);
    }
  }
});
