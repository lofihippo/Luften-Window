import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settingsToFields,
  fieldsToSettings,
  convertTemperatureFields,
} from "../public/ui/settings-form.js";

const SETTINGS = {
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
  forecastDays: 3,
  requireDrying: false,
  indoorReading: null,
};

test("form settings round-trip in either unit, including optional readings", () => {
  for (const units of ["C", "F"]) {
    const settings = { ...SETTINGS, units, coldestSurfaceC: 10.5, requireDrying: true, indoorReading: { tempC: 18.25, rh: 55 } };
    const original = structuredClone(settings);
    const fields = settingsToFields(settings);
    assert.equal(fields["indoor-temp"], units === "F" ? "62.6" : "17");
    assert.equal(fields.margin, "1.5");
    assert.equal(fields["forecast-days"], "3");
    assert.deepEqual(fieldsToSettings(fields), settings);
    assert.deepEqual(settings, original);
    assert.ok(Object.entries(fields).every(([key, value]) => typeof value === (key === "require-drying" ? "boolean" : "string")));
  }
});

test("switching F → C → F converts all unsaved temperatures without losing other edits", () => {
  const draft = {
    ...settingsToFields(SETTINGS),
    "indoor-temp": "68.5",
    "coldest-surface": "50.25",
    "min-outdoor": "41.5",
    "max-outdoor": "86.75",
    "indoor-reading-temp": "70.5",
    "indoor-reading-rh": "52",
    "target-rh": "57",
    "require-drying": true,
    "forecast-days": "5",
    label: "Unsaved place",
    lat: "0",
    margin: "2.75",
  };
  const original = structuredClone(draft);
  const celsius = convertTemperatureFields(draft, "F", "C");
  assert.equal(celsius.units, "C");
  assert.ok(Math.abs(Number(celsius["indoor-temp"]) - (68.5 - 32) * 5 / 9) < 1e-9);
  assert.ok(Math.abs(Number(celsius["indoor-reading-temp"]) - (70.5 - 32) * 5 / 9) < 1e-9);
  assert.deepEqual(convertTemperatureFields(celsius, "C", "F"), draft);
  assert.deepEqual(draft, original);
  assert.notEqual(celsius, draft);
  let repeated = draft;
  for (let i = 0; i < 100; i++) {
    repeated = convertTemperatureFields(convertTemperatureFields(repeated, "F", "C"), "C", "F");
  }
  assert.deepEqual(repeated, original);
});

test("unit conversion preserves blanks, invalid input, and untouched draft fields", () => {
  const draft = { ...settingsToFields(SETTINGS), "indoor-temp": "oops", "coldest-surface": " ", "min-outdoor": "", "max-outdoor": "Infinity", "indoor-reading-temp": "1e", margin: "pending", "target-rh": "", label: "Edited" };
  assert.deepEqual(convertTemperatureFields(draft, "F", "C"), { ...draft, units: "C" });
  for (const [from, to] of [["F", "F"], ["bad", "C"], ["F", "bad"]]) {
    const copy = convertTemperatureFields(draft, from, to);
    assert.deepEqual(copy, draft);
    assert.notEqual(copy, draft);
  }
  assert.equal(convertTemperatureFields({ "indoor-temp": "1e308" }, "C", "F")["indoor-temp"], "1e308");
});

test("blank required numbers remain invalid instead of becoming zero", () => {
  const draft = settingsToFields(SETTINGS);
  const keys = {
    "indoor-temp": "indoorTempC", "target-rh": "targetRH", margin: "marginC",
    "min-outdoor": "minOutdoorC", "max-outdoor": "maxOutdoorC", "max-rain": "maxRainProb",
    "max-wind": "maxWindKmh", "min-window-hours": "minWindowHours", "forecast-days": "forecastDays",
  };
  for (const [field, setting] of Object.entries(keys)) {
    assert.ok(Number.isNaN(fieldsToSettings({ ...draft, [field]: " " })[setting]), field);
  }
  assert.ok(Number.isNaN(fieldsToSettings({ ...draft, lat: "" }).location.lat));
  assert.ok(Number.isNaN(fieldsToSettings({ ...draft, lon: "" }).location.lon));
  assert.equal(fieldsToSettings({ ...draft, lat: "0", lon: "0" }).location.lat, 0);
  assert.equal(fieldsToSettings({ ...draft, label: "  Home  " }).location.label, "Home");
  assert.equal(fieldsToSettings(draft).coldestSurfaceC, null);
});

test("optional indoor reading is null only when both values are blank or drying is off", () => {
  const draft = { ...settingsToFields(SETTINGS), "require-drying": true };
  assert.equal(fieldsToSettings(draft).indoorReading, null);
  const missingRh = fieldsToSettings({ ...draft, "indoor-reading-temp": "68" }).indoorReading;
  assert.equal(missingRh.tempC, 20);
  assert.ok(Number.isNaN(missingRh.rh));
  const missingTemp = fieldsToSettings({ ...draft, "indoor-reading-rh": "50" }).indoorReading;
  assert.ok(Number.isNaN(missingTemp.tempC));
  assert.equal(missingTemp.rh, 50);
  assert.equal(fieldsToSettings({ ...draft, "require-drying": false, "indoor-reading-temp": "68", "indoor-reading-rh": "50" }).indoorReading, null);
});

test("reset fields clear optional surface and hidden indoor reading values", () => {
  const previous = settingsToFields({ ...SETTINGS, coldestSurfaceC: 12, requireDrying: true, indoorReading: { tempC: 20, rh: 60 } });
  const reset = { ...previous, ...settingsToFields(SETTINGS) };
  assert.equal(reset["require-drying"], false);
  assert.equal(reset["coldest-surface"], "");
  assert.equal(reset["indoor-reading-temp"], "");
  assert.equal(reset["indoor-reading-rh"], "");
  assert.deepEqual(fieldsToSettings(reset), SETTINGS);
});

test("malformed saved settings render safely without coercing missing temperatures to zero", () => {
  for (const malformed of [undefined, null, true, 5, "bad", [], { location: null, indoorReading: false }, { location: [], indoorReading: "bad" }]) {
    const fields = settingsToFields(malformed);
    assert.equal(fields.lat, "");
    assert.equal(fields.lon, "");
    assert.equal(fields.units, "");
    assert.equal(fields["indoor-temp"], "");
    assert.equal(fields["indoor-reading-temp"], "");
    assert.equal(fields["require-drying"], false);
  }
  for (const value of [undefined, null, Infinity, -Infinity, NaN, "20", false]) {
    const fields = settingsToFields({ ...SETTINGS, indoorTempC: value, coldestSurfaceC: value, indoorReading: { tempC: value, rh: value } });
    assert.equal(fields["indoor-temp"], "");
    assert.equal(fields["coldest-surface"], "");
    assert.equal(fields["indoor-reading-temp"], "");
    assert.equal(fields["indoor-reading-rh"], "");
  }
});

test("reading fields rejects malformed numeric values without mutating the draft", () => {
  for (const bad of [null, false, [], "NaN", "Infinity", "0x10", "1e", "12 nope"]) {
    const draft = { ...settingsToFields(SETTINGS), "indoor-temp": bad, lat: bad };
    const original = structuredClone(draft);
    const settings = fieldsToSettings(draft);
    assert.ok(Number.isNaN(settings.indoorTempC));
    assert.ok(Number.isNaN(settings.location.lat));
    assert.deepEqual(draft, original);
  }
  assert.equal(fieldsToSettings({ ...settingsToFields(SETTINGS), units: "C", "indoor-temp": "-2.5e1" }).indoorTempC, -25);
});

test("invalid saved units display Celsius values that can be repaired to Fahrenheit", () => {
  const fields = settingsToFields({ ...SETTINGS, units: "bad", coldestSurfaceC: 10 });
  assert.equal(fields.units, "");
  assert.equal(fields["indoor-temp"], "17");
  const repaired = convertTemperatureFields(fields, fields.units || "C", "F");
  assert.equal(repaired["indoor-temp"], "62.6");
  assert.equal(repaired["coldest-surface"], "50");
  assert.deepEqual(fieldsToSettings(repaired), { ...SETTINGS, coldestSurfaceC: 10 });
});
