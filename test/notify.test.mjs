import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { send, sendNtfy } from "../scripts/notify.mjs";

// Any missed injection fails safely, even when real channel secrets are present.
beforeEach((t) => {
  const guard = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected use of global fetch in notification test");
  });
  t.after(() => assert.equal(guard.mock.callCount(), 0, "all HTTP calls must use the injected transport"));
});

const channelNames = ["ntfy", "email", "discord", "telegram"];
const configuredEnv = {
  NTFY_TOPIC: "test-topic",
  NTFY_SERVER: "https://ntfy.example.invalid/",
  RESEND_API_KEY: "synthetic-api-key",
  EMAIL_FROM: "sender@example.invalid",
  EMAIL_TO: "first@example.invalid, second@example.invalid",
  DISCORD_WEBHOOK_URL: "https://discord.example.invalid/webhook",
  TELEGRAM_BOT_TOKEN: "synthetic-bot-token",
  TELEGRAM_CHAT_ID: "synthetic-chat-id",
};
const message = { title: "Open windows", body: "Cool <outside> & dry", tags: "window" };

function captureTransport(respond = async () => ({ ok: true, status: 200 })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return respond(url, options, calls.length);
    },
  };
}

function captureLogger() {
  const logs = [];
  return { logs, logger: { log: (line) => logs.push(line) } };
}

test("dispatcher skips all unconfigured channels without making HTTP requests", async () => {
  const { calls, fetchImpl } = captureTransport();
  const { logs, logger } = captureLogger();
  const results = await send(message, { env: {}, fetchImpl, logger });

  assert.deepEqual(results, channelNames.map((channel) => ({ channel, ok: false, skipped: true })));
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, channelNames.map((channel) => `notify[${channel}]: skipped (not configured)`));
});

test("dispatcher sends each configured channel its expected URL, headers, and payload", async () => {
  const { calls, fetchImpl } = captureTransport();
  const { logs, logger } = captureLogger();
  const results = await send(message, { env: configuredEnv, fetchImpl, logger });

  assert.deepEqual(results, channelNames.map((channel) => ({ channel, ok: true })));
  assert.equal(calls.length, 4);
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal, "each request must retain its timeout signal");
    assert.equal(options.signal.aborted, false);
  }
  assert.equal(calls[0].url, "https://ntfy.example.invalid/test-topic");
  assert.deepEqual(calls[0].options.headers, { Title: message.title, Tags: message.tags });
  assert.equal(calls[0].options.body, message.body);

  assert.equal(calls[1].url, "https://api.resend.com/emails");
  assert.deepEqual(calls[1].options.headers, {
    Authorization: "Bearer synthetic-api-key",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    from: "sender@example.invalid",
    to: ["first@example.invalid", "second@example.invalid"],
    subject: message.title,
    text: message.body,
    html: "<pre>Cool &lt;outside&gt; &amp; dry</pre>",
  });

  assert.equal(calls[2].url, configuredEnv.DISCORD_WEBHOOK_URL);
  assert.deepEqual(calls[2].options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[2].options.body), { content: message.body });

  assert.equal(calls[3].url, "https://api.telegram.org/botsynthetic-bot-token/sendMessage");
  assert.deepEqual(calls[3].options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    chat_id: configuredEnv.TELEGRAM_CHAT_ID,
    text: `${message.title}\n${message.body}`,
  });
  assert.deepEqual(logs, channelNames.map((channel) => `notify[${channel}]: sent`));
});

test("dispatcher retries only selected channels and rejects unknown selections", async () => {
  const { calls, fetchImpl } = captureTransport();
  const { logs, logger } = captureLogger();
  const results = await send(message, { env: configuredEnv, fetchImpl, logger, channels: ["email", "telegram"] });
  assert.deepEqual(results, [{ channel: "email", ok: true }, { channel: "telegram", ok: true }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.match(calls[1].url, /telegram/);
  assert.deepEqual(logs, ["notify[email]: sent", "notify[telegram]: sent"]);
  await assert.rejects(send(message, { env: configuredEnv, fetchImpl, logger, channels: ["unknown"] }), /Unknown notification channel/);
  assert.equal(calls.length, 2);
});

for (const failure of [
  { name: "HTTP failure", respond: async () => ({ ok: false, status: 503 }), error: "HTTP 503" },
  { name: "thrown transport error", respond: async () => { throw new Error("synthetic network error"); }, error: "synthetic network error" },
]) {
  test(`dispatcher isolates a ${failure.name} and still sends subsequent channels`, async () => {
    const { calls, fetchImpl } = captureTransport(async (_url, _options, count) => (
      count === 2 ? failure.respond() : { ok: true, status: 200 }
    ));
    const { logs, logger } = captureLogger();
    const results = await send(message, { env: configuredEnv, fetchImpl, logger });

    assert.deepEqual(results, [
      { channel: "ntfy", ok: true },
      { channel: "email", ok: false, error: failure.error },
      { channel: "discord", ok: true },
      { channel: "telegram", ok: true },
    ]);
    assert.equal(calls.length, 4, "a failed email must not suppress Discord or Telegram");
    assert.equal(calls[2].url, configuredEnv.DISCORD_WEBHOOK_URL);
    assert.equal(calls[3].url, "https://api.telegram.org/botsynthetic-bot-token/sendMessage");
    assert.deepEqual(logs, [
      "notify[ntfy]: sent",
      `notify[email]: ${failure.error}`,
      "notify[discord]: sent",
      "notify[telegram]: sent",
    ]);
  });
}

test("dispatcher skips channels with incomplete credentials while sending configured channels", async () => {
  const incompleteEnvs = [
    { EMAIL_FROM: "sender@example.invalid", EMAIL_TO: "to@example.invalid", TELEGRAM_BOT_TOKEN: "token" },
    { RESEND_API_KEY: "key", EMAIL_TO: "to@example.invalid", TELEGRAM_CHAT_ID: "chat" },
    { RESEND_API_KEY: "key", EMAIL_FROM: "sender@example.invalid" },
  ];
  for (const partialEnv of incompleteEnvs) {
    const { calls, fetchImpl } = captureTransport();
    const { logger } = captureLogger();
    const results = await send(message, {
      env: { ...partialEnv, DISCORD_WEBHOOK_URL: configuredEnv.DISCORD_WEBHOOK_URL },
      fetchImpl,
      logger,
    });
    assert.deepEqual(results, [
      { channel: "ntfy", ok: false, skipped: true },
      { channel: "email", ok: false, skipped: true },
      { channel: "discord", ok: true },
      { channel: "telegram", ok: false, skipped: true },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, configuredEnv.DISCORD_WEBHOOK_URL);
  }
});

test("dispatcher supports the default ntfy server and messages without an optional title or tags", async () => {
  const { calls, fetchImpl } = captureTransport();
  const { logger } = captureLogger();
  const results = await send({ body: "Fresh air" }, {
    env: { NTFY_TOPIC: "test-topic", TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "chat" },
    fetchImpl,
    logger,
  });

  assert.deepEqual(results, [
    { channel: "ntfy", ok: true },
    { channel: "email", ok: false, skipped: true },
    { channel: "discord", ok: false, skipped: true },
    { channel: "telegram", ok: true },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://ntfy.sh/test-topic");
  assert.deepEqual(calls[0].options.headers, {});
  assert.deepEqual(JSON.parse(calls[1].options.body), { chat_id: "chat", text: "Fresh air" });
});

test("sendNtfy returns its legacy missing-topic result without HTTP requests", async () => {
  const { calls, fetchImpl } = captureTransport();
  assert.deepEqual(await sendNtfy(message, { fetchImpl }), { ok: false, error: "no topic" });
  assert.equal(calls.length, 0);
});

test("sendNtfy preserves its message options and default server with an injected transport", async () => {
  for (const server of [undefined, "https://ntfy.example.invalid/"]) {
    const { calls, fetchImpl } = captureTransport();
    const result = await sendNtfy({ ...message, topic: "test-topic", server }, { fetchImpl });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${server ? "https://ntfy.example.invalid" : "https://ntfy.sh"}/test-topic`);
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(calls[0].options.headers, { Title: message.title, Tags: message.tags });
    assert.equal(calls[0].options.body, message.body);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  }
});

test("sendNtfy returns HTTP failures and transport exceptions without throwing", async () => {
  for (const failure of [
    { respond: async () => ({ ok: false, status: 429 }), error: "HTTP 429" },
    { respond: async () => { throw new Error("synthetic timeout"); }, error: "synthetic timeout" },
  ]) {
    const { calls, fetchImpl } = captureTransport(failure.respond);
    const result = await sendNtfy({ ...message, topic: "test-topic" }, { fetchImpl });
    assert.deepEqual(result, { ok: false, error: failure.error });
    assert.equal(calls.length, 1);
  }
});
