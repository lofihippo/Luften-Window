import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryNamespace,
  configuredChannels,
  normalizeDeliveryState,
  pendingChannels,
  recordDeliveryResults,
} from "../scripts/delivery-state.mjs";

const settings = {
  location: { lat: 40.71, lon: -74.01, label: "Home" },
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
  notify: { enabled: true, leadHours: 1 },
};
const namespace = deliveryNamespace(settings, "America/New_York");
const env = {
  NTFY_TOPIC: "test-topic",
  RESEND_API_KEY: "test-key",
  EMAIL_FROM: "sender@example.invalid",
  EMAIL_TO: "recipient@example.invalid",
};

test("namespace changes with forecast identity, but not a label or lead time", () => {
  assert.match(namespace, /^[a-f0-9]{64}$/);
  assert.equal(deliveryNamespace({ ...settings, location: { ...settings.location, label: "Elsewhere" } }, "America/New_York"), namespace);
  assert.equal(deliveryNamespace({ ...settings, notify: { enabled: true, leadHours: 6 } }, "America/New_York"), namespace);
  assert.notEqual(deliveryNamespace({ ...settings, location: { ...settings.location, lat: 43 } }, "America/New_York"), namespace);
  assert.notEqual(deliveryNamespace({ ...settings, targetRH: 20 }, "America/New_York"), namespace);
  assert.notEqual(deliveryNamespace(settings, "America/Chicago"), namespace);
});

test("only complete destinations are configured and state stores fingerprints", () => {
  const identities = configuredChannels({
    ...env,
    DISCORD_WEBHOOK_URL: " ",
    TELEGRAM_BOT_TOKEN: "token-without-chat",
  });
  assert.deepEqual(Object.keys(identities), ["ntfy", "email"]);
  assert.match(identities.ntfy, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(identities), /test-topic|test-key|recipient@/);
  assert.deepEqual(configuredChannels({ NTFY_TOPIC: " ", EMAIL_FROM: "a" }), {});
});

test("legacy markers and a mismatched namespace cannot suppress a new delivery", () => {
  const identities = configuredChannels(env);
  const event = "open:1780000000";
  const legacy = { notifiedStarts: ["1780000000"], notifiedEnds: [], digestSentDate: "2026-05-27" };
  const migrated = normalizeDeliveryState(legacy, namespace);
  assert.deepEqual(migrated, { version: 2, namespace, delivered: {} });
  assert.deepEqual(pendingChannels(migrated, event, identities), ["ntfy", "email"]);

  const changedSettings = normalizeDeliveryState({
    version: 2,
    namespace: deliveryNamespace({ ...settings, targetRH: 20 }, "America/New_York"),
    delivered: { [event]: { ntfy: identities.ntfy } },
  }, namespace);
  assert.deepEqual(pendingChannels(changedSettings, event, identities), ["ntfy", "email"]);
});

test("invalid v2 event and channel entries are discarded", () => {
  const identities = configuredChannels(env);
  const raw = {
    version: 2,
    namespace,
    delivered: {
      "open:1780000000": { ntfy: identities.ntfy, email: true, unknown: identities.email },
      "open:garbage": { email: identities.email },
      "digest:2026-05-27": { email: identities.email },
    },
  };
  const clean = normalizeDeliveryState(raw, namespace);
  assert.deepEqual(clean.delivered, {
    "open:1780000000": { ntfy: identities.ntfy },
    "digest:2026-05-27": { email: identities.email },
  });
  assert.deepEqual(pendingChannels(clean, "open:1780000000", identities), ["email"]);
  assert.deepEqual(pendingChannels(clean, "digest:2026-05-27", identities), ["ntfy"]);
});

test("failed, skipped and absent results stay pending; successful channel is skipped on retry", () => {
  const identities = configuredChannels(env);
  const event = "open:1780000000";
  const state = normalizeDeliveryState(null, namespace);

  assert.equal(recordDeliveryResults(state, event, identities, [
    { channel: "ntfy", ok: true },
    { channel: "email", ok: false, error: "HTTP 500" },
  ]), true);
  assert.deepEqual(pendingChannels(state, event, identities), ["email"]);

  assert.equal(recordDeliveryResults(state, event, identities, [
    { channel: "email", ok: false, skipped: true },
  ]), false);
  assert.equal(recordDeliveryResults(state, event, identities, undefined), false);
  assert.deepEqual(pendingChannels(state, event, identities), ["email"]);

  assert.equal(recordDeliveryResults(state, event, { email: identities.email }, [
    { channel: "email", ok: true },
    { channel: "discord", ok: true },
  ]), true);
  assert.deepEqual(pendingChannels(state, event, identities), []);
});

test("rotating one destination retries only that channel", () => {
  const oldIds = configuredChannels(env);
  const newIds = configuredChannels({ ...env, EMAIL_TO: "new@example.invalid" });
  const event = "digest:2026-05-27";
  const state = normalizeDeliveryState(null, namespace);
  recordDeliveryResults(state, event, oldIds, [
    { channel: "ntfy", ok: true }, { channel: "email", ok: true },
  ]);
  assert.deepEqual(pendingChannels(state, event, newIds), ["email"]);
  recordDeliveryResults(state, event, { email: newIds.email }, [{ channel: "email", ok: true }]);
  assert.deepEqual(pendingChannels(state, event, newIds), []);
  assert.equal(state.delivered[event].ntfy, oldIds.ntfy);
  assert.equal(state.delivered[event].email, newIds.email);
});

test("state retains the most recently updated 100 events", () => {
  const identities = configuredChannels({ NTFY_TOPIC: "test-topic" });
  const state = normalizeDeliveryState(null, namespace);
  for (let i = 0; i < 101; i++) {
    recordDeliveryResults(state, `open:${1780000000 + i}`, identities, [{ channel: "ntfy", ok: true }]);
  }
  assert.equal(Object.keys(state.delivered).length, 100);
  assert.equal(state.delivered["open:1780000000"], undefined);
  assert.deepEqual(pendingChannels(state, "open:1780000100", identities), []);
});
