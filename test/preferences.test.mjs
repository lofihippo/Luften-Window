import { test } from "node:test";
import assert from "node:assert/strict";
import { readPreferences, writePreferences, clearPreferences, STORAGE_KEY } from "../public/ui/preferences.js";

test("preferences survive a write/read round trip and reset removes only the settings key", () => {
  const data = new Map([["unrelated", "keep"]]);
  const getStorage = () => ({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  });
  assert.deepEqual(readPreferences(getStorage), { settings: {}, notice: "" });
  const settings = { units: "C", forecastDays: 5, coldestSurfaceC: null, requireDrying: false };
  assert.equal(writePreferences(settings, getStorage), true);
  assert.deepEqual(readPreferences(getStorage), { settings, notice: "" });
  assert.ok(data.has(STORAGE_KEY));
  assert.equal(clearPreferences(getStorage), true);
  assert.deepEqual([...data], [["unrelated", "keep"]]);
});

test("malformed JSON and non-object saved values are ignored with a readable notice", () => {
  for (const raw of ["{", "null", "false", "0", '"settings"', "[]"]) {
    const result = readPreferences(() => ({ getItem: () => raw }));
    assert.deepEqual(result.settings, {});
    assert.ok(result.notice.length > 0, raw);
  }
});

test("malformed nested settings remain visible to the settings validator", () => {
  const saved = { location: null, indoorReading: [], targetRH: "invalid" };
  assert.deepEqual(readPreferences(() => ({ getItem: () => JSON.stringify(saved) })).settings, saved);
});

test("a blocked localStorage getter cannot prevent read, save, or reset", () => {
  const blocked = () => { throw new Error("storage blocked"); };
  assert.deepEqual(readPreferences(blocked).settings, {});
  assert.match(readPreferences(blocked).notice, /could not be read/);
  assert.equal(writePreferences({ units: "C" }, blocked), false);
  assert.equal(clearPreferences(blocked), false);
});

test("storage method errors and quota failures return failure instead of throwing", () => {
  const blocked = () => ({
    getItem: () => { throw new Error("read denied"); },
    setItem: () => { throw new Error("quota exceeded"); },
    removeItem: () => { throw new Error("remove denied"); },
  });
  assert.deepEqual(readPreferences(blocked).settings, {});
  assert.equal(writePreferences({ units: "F" }, blocked), false);
  assert.equal(clearPreferences(blocked), false);
});
