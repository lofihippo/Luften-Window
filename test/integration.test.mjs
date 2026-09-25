import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../scripts/check.mjs";
import { send } from "../scripts/notify.mjs";
import { validateDeliveryState, validatePagesTree, validatePublicBundle } from "../scripts/actions-state.mjs";
import { isCalendarFeed } from "../public/core/calendar.js";
import { createForecastController, MAX_FORECAST_AGE } from "../public/ui/forecast-controller.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/openmeteo-sample.json", import.meta.url), "utf8"));
const HOUR = 3600;
// The fixture's first suitable opening lasts from hour 24 through hour 32.
const OPEN_START = fixture.hourly.time[24];
const OPEN_END = fixture.hourly.time[32];
const CHECK_TIME = OPEN_START - HOUR / 2;
const CONFIG = {
  location: { lat: 40.7128, lon: -74.0060, label: "Integration home" },
  units: "F", indoorTempC: 17, targetRH: 50, coldestSurfaceC: null,
  marginC: 1.5, minOutdoorC: 4, maxOutdoorC: 29, maxRainProb: 30,
  maxWindKmh: 40, minWindowHours: 2, requireDrying: false,
  indoorReading: null, forecastDays: 3,
  notify: { enabled: true, realtime: true, leadHours: 1, digest: { enabled: false, hourLocal: 7 } },
};
const ENV = {
  NTFY_SERVER: "https://ntfy.example.invalid", NTFY_TOPIC: "integration-topic",
  RESEND_API_KEY: "integration-synthetic-key",
  EMAIL_FROM: "fixture@example.invalid", EMAIL_TO: "recipient@example.invalid",
};

beforeEach((t) => {
  const guard = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected real HTTP request in integration test");
  });
  t.after(() => assert.equal(guard.mock.callCount(), 0, "every HTTP transport must be injected"));
});

async function harness(t, { firstEmailFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "openwindow-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicRoot = join(root, "public");
  const dataDir = join(publicRoot, "data");
  const output = join(dataDir, "windows.json");
  const calendar = join(dataDir, "windows.ics");
  const statusFile = join(dataDir, "check-status.json");
  const stateFile = join(root, "private", "state.json");
  const posts = [];
  let emailAttempts = 0;
  const channelFetch = async (url, options) => {
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    posts.push({ url, options });
    if (url === "https://api.resend.com/emails") {
      emailAttempts++;
      if (firstEmailFails && emailAttempts === 1) return { ok: false, status: 503 };
    } else {
      assert.equal(url, `${ENV.NTFY_SERVER}/${ENV.NTFY_TOPIC}`);
    }
    return { ok: true, status: 200 };
  };
  const pass = (overrides = {}) => run({
    config: structuredClone(CONFIG), env: { ...ENV }, output, stateFile, now: CHECK_TIME,
    fetchImpl: async () => ({ ok: true, json: async () => structuredClone(fixture) }),
    notifyImpl: (message, { channels }) => send(message, {
      env: { ...ENV }, channels, fetchImpl: channelFetch, logger: { log() {} },
    }),
    ...overrides,
  });
  const bundle = async () => {
    const [json, ics, status, files] = await Promise.all([
      readFile(output, "utf8"), readFile(calendar, "utf8"), readFile(statusFile, "utf8"), readdir(dataDir),
    ]);
    await validatePagesTree(publicRoot);
    const verified = validatePublicBundle({ json, ics, status, files });
    return { json, ics, status, files: files.sort(), verified };
  };
  const browser = (now) => {
    let clock = now;
    const cacheWrites = [];
    const controller = createForecastController({
      fetchLive: async () => { throw new Error("Fixture browser is offline"); },
      fetchBackground: async () => JSON.parse(await readFile(output, "utf8")),
      fetchCheckStatus: async () => JSON.parse(await readFile(statusFile, "utf8")),
      checkFeed: async () => isCalendarFeed(await readFile(calendar, "utf8")),
      readCache: () => null,
      writeCache: (value) => cacheWrites.push(value),
      onState: () => {}, now: () => clock,
    });
    return { controller, cacheWrites, setNow: (value) => { clock = value; } };
  };
  return { pass, bundle, browser, posts, stateFile };
}

test("real checker publication feeds offline browser advice and retains per-channel delivery across passes", async (t) => {
  const h = await harness(t, { firstEmailFails: true });
  assert.equal((await h.pass()).changed, true);
  const first = await h.bundle();
  const published = JSON.parse(first.json);
  assert.equal(published.windows[0].start, OPEN_START);
  assert.equal(published.windows[0].end, OPEN_END);
  assert.equal(published.status.openNow, false);
  assert.deepEqual(first.files, ["check-status.json", "windows.ics", "windows.json"]);
  const firstState = validateDeliveryState(await readFile(h.stateFile, "utf8"));
  assert.deepEqual(Object.keys(firstState.delivered[`open:${OPEN_START}`]), ["ntfy"]);

  // A fresh pass reloads the on-disk ledger and invokes the actual dispatcher.
  // Successful ntfy delivery is not repeated when the email transport recovers.
  assert.equal((await h.pass({ now: CHECK_TIME + 60 })).changed, false);
  const second = await h.bundle();
  assert.equal(second.json, first.json);
  assert.equal(second.ics, first.ics);
  assert.equal(second.verified.generatedAt, first.verified.generatedAt);
  assert.equal(second.verified.checkedAt, new Date((CHECK_TIME + 60) * 1000).toISOString());
  assert.deepEqual(h.posts.map(({ url }) => url), [
    `${ENV.NTFY_SERVER}/${ENV.NTFY_TOPIC}`, "https://api.resend.com/emails", "https://api.resend.com/emails",
  ]);
  const persisted = await readFile(h.stateFile, "utf8");
  const secondState = validateDeliveryState(persisted);
  assert.deepEqual(Object.keys(secondState.delivered[`open:${OPEN_START}`]).sort(), ["email", "ntfy"]);
  for (const secret of [ENV.NTFY_TOPIC, ENV.RESEND_API_KEY, ENV.EMAIL_TO]) {
    assert.equal(persisted.includes(secret), false, "private ledger stores destination hashes, not credentials");
    assert.equal((second.json + second.ics + second.status).includes(secret), false);
  }

  const { controller, cacheWrites } = h.browser(OPEN_START + HOUR);
  await controller.refresh(CONFIG);
  const view = controller.getState();
  assert.equal(view.phase, "ready");
  assert.equal(view.source, "background");
  assert.equal(view.status.openNow, true, "browser replans advice after the opening begins");
  assert.equal(view.windows[0].start, OPEN_START, "complete history retains the real window identity");
  assert.equal(view.status.remainingSeconds, OPEN_END - (OPEN_START + HOUR));
  assert.equal(view.feedAvailable, true);
  assert.equal(view.checker.checkedAt, CHECK_TIME + 60);
  assert.equal(view.checker.publishedAt, CHECK_TIME);

  await controller.refresh({ ...CONFIG, targetRH: 20 });
  assert.equal(controller.getState().status.openNow, false, "personal thresholds override shared checker advice");
  assert.ok(controller.getState().status.reasons.includes("DEW_TOO_HIGH"));
  assert.equal(controller.getState().feedAvailable, true, "the shared calendar remains independently available");
  assert.deepEqual(cacheWrites, [], "background fallback does not overwrite the live browser cache");
  assert.equal((await h.bundle()).json, first.json, "personal browser settings do not rewrite shared data");
});

test("failed checker pass preserves a complete last-good publication until browser freshness expires", async (t) => {
  const h = await harness(t);
  await h.pass();
  const before = await h.bundle();
  const stateBefore = await readFile(h.stateFile, "utf8");
  const postCount = h.posts.length;
  await assert.rejects(h.pass({
    now: CHECK_TIME + 60,
    fetchImpl: async () => { throw new Error("Fixture weather service unavailable"); },
  }), /Fixture weather service unavailable/);
  assert.deepEqual(await h.bundle(), before);
  assert.equal(await readFile(h.stateFile, "utf8"), stateBefore);
  assert.equal(h.posts.length, postCount, "a failed weather fetch cannot send notifications");

  const { controller, setNow } = h.browser(OPEN_START + HOUR);
  await controller.refresh(CONFIG);
  assert.equal(controller.getState().source, "background");
  assert.equal(controller.getState().status.openNow, true);
  setNow(CHECK_TIME + MAX_FORECAST_AGE + 1);
  controller.tick();
  const expired = controller.getState();
  assert.equal(expired.phase, "unavailable", "old advice expires while usable forecast hours still remain");
  assert.deepEqual(expired.windows, []);
  assert.deepEqual(expired.evaluated, []);
  assert.equal(expired.feedAvailable, false);
});
