import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticHandler, serverAddress } from "../scripts/serve.mjs";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "ow-serve-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "public");
  const sibling = join(base, "public-backup");
  await mkdir(root);
  await mkdir(sibling);
  await mkdir(join(root, "data"));
  await writeFile(join(root, "index.html"), "home");
  await writeFile(join(root, "data/windows.json"), "{}");
  await writeFile(join(root, "data/state.json"), "private state");
  await writeFile(join(sibling, "secret.txt"), "private");
  await symlink(join(sibling, "secret.txt"), join(root, "linked-secret.txt"));
  return { root };
}

function response() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body = "") { this.body = body; return this; },
  };
}

test("static handler serves a regular file and HEAD without exposing its body", async (t) => {
  const { root } = await fixture(t);
  const handler = createStaticHandler({ rootDir: root });
  const get = response();
  await handler({ url: "/?q=1", method: "GET" }, get);
  assert.equal(get.status, 200);
  assert.equal(String(get.body), "home");
  assert.match(get.headers["Content-Type"], /text\/html/);

  const head = response();
  await handler({ url: "/index.html", method: "HEAD" }, head);
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("static handler rejects encoded traversal, sibling paths, and symlink escape", async (t) => {
  const { root } = await fixture(t);
  const handler = createStaticHandler({ rootDir: root });
  for (const url of [
    "/%2e%2e/public-backup/secret.txt",
    "/%2e%2e%2fpublic-backup%2fsecret.txt",
    "/linked-secret.txt",
  ]) {
    const res = response();
    await handler({ url, method: "GET" }, res);
    assert.equal(res.status, 403, url);
    assert.doesNotMatch(String(res.body), /private|ow-serve-test/);
  }
});

test("static handler returns controlled responses for malformed, missing and failed reads", async (t) => {
  const { root } = await fixture(t);
  const handler = createStaticHandler({ rootDir: root });
  for (const [url, status] of [["/%zz", 400], ["/missing", 404], ["/bad\\path", 400]]) {
    const res = response();
    await handler({ url, method: "GET" }, res);
    assert.equal(res.status, status);
    assert.doesNotMatch(String(res.body), /ow-serve-test/);
  }
  const broken = createStaticHandler({ rootDir: root, readFileImpl: async () => {
    throw new Error("secret implementation path");
  } });
  const res = response();
  await broken({ url: "/index.html", method: "GET" }, res);
  assert.equal(res.status, 500);
  assert.equal(String(res.body), "Internal server error");
});

test("static handler never serves a legacy public state file and disables data caching", async (t) => {
  const { root } = await fixture(t);
  const handler = createStaticHandler({ rootDir: root });
  const state = response();
  await handler({ url: "/data/state.json", method: "GET" }, state);
  assert.equal(state.status, 404);
  assert.doesNotMatch(String(state.body), /private/);
  const forecast = response();
  await handler({ url: "/data/windows.json", method: "GET" }, forecast);
  assert.equal(forecast.status, 200);
  assert.equal(forecast.headers["Cache-Control"], "no-store");
});

test("static server binds loopback by default and validates explicit overrides", () => {
  assert.deepEqual(serverAddress({}), { host: "127.0.0.1", port: 8080 });
  assert.deepEqual(serverAddress({ HOST: "0.0.0.0", PORT: "9090" }), { host: "0.0.0.0", port: 9090 });
  for (const PORT of ["", "0", "65536", "bad", "3.5"]) {
    assert.throws(() => serverAddress({ PORT }), /PORT/);
  }
});
