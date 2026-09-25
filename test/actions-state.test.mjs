import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCalendar } from "../public/core/calendar.js";
import { pendingChannels, recordDeliveryResults } from "../scripts/delivery-state.mjs";
import { findLatestStateArtifact, validateDeliveryState, validatePublicBundle, verifyCurrentMain,
  validatePagesTree } from "../scripts/actions-state.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = 1_789_700_000;
const created = (day) => `2026-09-${String(day).padStart(2, "0")}T10:00:00Z`;
const artifact = (id, runId, day, branch = "main", extra = {}) => ({
  id, name: `checker-delivery-state-v2-${runId}-1`, expired: false, created_at: created(day),
  workflow_run: { id: runId, head_branch: branch }, ...extra,
});
const run = (id, event = "schedule", extra = {}) => ({
  id, status: "completed", event, head_branch: "main", path: ".github/workflows/pages.yml@main",
  ...extra,
});

function apiFrom({ artifacts, runs }) {
  return async (path) => {
    if (path.includes("/artifacts?")) return { artifacts };
    const id = Number(path.match(/\/runs\/(\d+)/)?.[1]);
    if (runs.has(id)) return runs.get(id);
    throw new Error(`Unexpected API path: ${path}`);
  };
}

async function publicationRepository(t) {
  const dir = await mkdtemp(join(tmpdir(), "ow-actions-revision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git");
  const checkout = join(dir, "checkout");
  const gitAt = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  gitAt(dir, "init", "--bare", "-q", "--initial-branch=main", remote);
  gitAt(dir, "clone", "-q", remote, checkout);
  const git = (...args) => gitAt(checkout, ...args);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await mkdir(join(checkout, "public/data"), { recursive: true });
  await writeFile(join(checkout, "public/data/windows.json"), "original");
  git("add", "public/data");
  git("commit", "-qm", "initial");
  git("push", "-qu", "origin", "main");
  return { dir, remote, checkout, git, gitAt };
}

function workflowCommitScript(yaml) {
  const step = yaml.split("      - name: Commit verified updated data\n")[1]?.split("\n      - name:")[0];
  assert.ok(step, "verified data commit step must exist");
  const script = step.split("        run: |\n")[1];
  assert.ok(script, "verified data commit step must have a shell script");
  return script.split("\n").filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10)).join("\n");
}

test("Pages accepts current main and rejects a queued checkout after main advances", async (t) => {
  const { checkout, git } = await publicationRepository(t);
  const original = git("rev-parse", "HEAD");
  assert.equal(verifyCurrentMain({ cwd: checkout }), original);
  await writeFile(join(checkout, "new-code.txt"), "new code");
  git("add", "new-code.txt");
  git("commit", "-qm", "new main");
  git("push", "-q");
  git("checkout", "-q", "--detach", original);
  assert.throws(() => verifyCurrentMain({ cwd: checkout }), /Main has advanced/);
});

test("Pages revision verification fails closed when the remote cannot be read", async (t) => {
  const { checkout, git, dir } = await publicationRepository(t);
  git("remote", "set-url", "origin", join(dir, "missing.git"));
  assert.throws(() => verifyCurrentMain({ cwd: checkout }), /Cannot verify current main/);
});

test("workflow publication pushes changed data and leaves unchanged data without an extra commit", async (t) => {
  const { checkout, git } = await publicationRepository(t);
  const yaml = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const script = workflowCommitScript(yaml);
  const original = git("rev-parse", "HEAD");
  execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: checkout, stdio: "pipe" });
  assert.equal(git("rev-parse", "HEAD"), original);
  await writeFile(join(checkout, "public/data/windows.json"), "updated");
  execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: checkout, stdio: "pipe" });
  assert.notEqual(git("rev-parse", "HEAD"), original);
  assert.equal(verifyCurrentMain({ cwd: checkout }), git("rev-parse", "HEAD"));
  assert.equal(git("log", "-1", "--format=%s"), "chore: update forecast data [skip ci]");
});

test("a conflicting main push stops the workflow shell without losing the saved delivery ledger", async (t) => {
  const { dir, remote, checkout, git, gitAt } = await publicationRepository(t);
  const yaml = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const other = join(dir, "other");
  gitAt(dir, "clone", "-q", remote, other);
  gitAt(other, "config", "user.name", "Other fixture");
  gitAt(other, "config", "user.email", "other@example.test");
  await writeFile(join(other, "new-code.txt"), "new code");
  gitAt(other, "add", "new-code.txt");
  gitAt(other, "commit", "-qm", "concurrent main change");
  gitAt(other, "push", "-q");
  const latest = gitAt(other, "rev-parse", "HEAD");
  const state = JSON.stringify({ version: 2, namespace: HASH_A, delivered: { "open:123": { ntfy: HASH_B } } });
  await mkdir(join(checkout, ".state"));
  await writeFile(join(checkout, ".state/state.json"), state);
  await writeFile(join(checkout, "public/data/windows.json"), "updated");
  const script = `${workflowCommitScript(yaml)}\nprintf 'unexpected deployment' > deployed.txt`;
  assert.throws(() => execFileSync("bash", ["-e", "-o", "pipefail", "-c", script],
    { cwd: checkout, stdio: "pipe" }));
  assert.equal(gitAt(remote, "rev-parse", "main"), latest);
  assert.equal(await readFile(join(checkout, ".state/state.json"), "utf8"), state);
  assert.deepEqual(pendingChannels(validateDeliveryState(state), "open:123", { ntfy: HASH_B }), []);
  assert.ok(!(await readdir(checkout)).includes("deployed.txt"));
  assert.throws(() => verifyCurrentMain({ cwd: checkout }), /Main has advanced/);
  assert.ok(!git("ls-files").includes(".state/"));
});

test("fresh Actions run restores the newest completed state artifact even when its workflow later failed", async () => {
  const calls = new Map([
    [31, run(31, "schedule", { conclusion: "failure" })],
    [30, run(30, "workflow_dispatch", { status: "in_progress" })],
    [29, run(29, "push")],
  ]);
  const found = await findLatestStateArtifact({
    api: apiFrom({ artifacts: [
      artifact(9, 33, 22, "other-branch"),
      artifact(8, 32, 21, "main", { expired: true }),
      artifact(7, 30, 20),
      artifact(6, 29, 19),
      artifact(5, 31, 18),
      artifact(4, 34, 17),
    ], runs: calls }),
    repository: "owner/repo", branch: "main", currentRunId: "34",
  });
  assert.deepEqual(found, { id: 5, name: "checker-delivery-state-v2-31-1", runId: 31,
    createdAt: created(18) });
});

test("a rerun can restore its own earlier completed attempt without overwriting that artifact", async () => {
  const found = await findLatestStateArtifact({
    api: apiFrom({ artifacts: [artifact(8, 40, 22)],
      runs: new Map([[40, run(40, "schedule", { status: "in_progress" })]]) }),
    repository: "owner/repo", branch: "main", currentRunId: 40, currentRunAttempt: 2,
  });
  assert.equal(found.id, 8);
  assert.equal(found.name, "checker-delivery-state-v2-40-1");
  assert.equal(found.runId, 40);
});

test("state restore accepts GitHub's bare workflow path and qualified paths, but rejects other workflows", async () => {
  for (const [path, eligible] of [
    [".github/workflows/pages.yml", true],
    [".github/workflows/pages.yml@main", true],
    [".github/workflows/ci.yml", false],
    [".github/workflows/pages.yml.backup@main", false],
    [undefined, false],
  ]) {
    const found = await findLatestStateArtifact({
      api: apiFrom({ artifacts: [artifact(8, 40, 22)],
        runs: new Map([[40, run(40, "workflow_dispatch", { path })]]) }),
      repository: "owner/repo", branch: "main", currentRunId: 41,
    });
    assert.equal(found?.id ?? null, eligible ? 8 : null, `workflow path: ${path}`);
  }
});

test("state restore compares all artifact pages instead of trusting API listing order", async () => {
  const older = artifact(7, 37, 18);
  const newer = artifact(8, 38, 19);
  const filler = Array.from({ length: 99 }, (_, index) => ({ id: 1_000 + index, name: "github-pages" }));
  const found = await findLatestStateArtifact({
    api: async (path) => {
      if (path.includes("/artifacts?")) return {
        artifacts: path.endsWith("page=1") ? [older, ...filler] : [newer],
      };
      const id = Number(path.match(/\/runs\/(\d+)/)?.[1]);
      return run(id);
    },
    repository: "owner/repo", branch: "main", currentRunId: 40,
  });
  assert.equal(found.id, 8);
});

test("two fresh runs retain successful channels after a later failed checker/deploy", async () => {
  // Run 1: ntfy confirms, email fails. The checker writes the ledger and the
  // workflow uploads it before a later public verification/commit failure.
  const first = { version: 2, namespace: HASH_A, delivered: {}, lastCheckedAt: "2026-09-22T10:00:00.000Z" };
  const destinations = { ntfy: HASH_A, email: HASH_B };
  assert.deepEqual(pendingChannels(first, "open:123", destinations), ["ntfy", "email"]);
  recordDeliveryResults(first, "open:123", destinations, [
    { channel: "ntfy", ok: true }, { channel: "email", ok: false },
  ]);
  const uploadedBytes = JSON.stringify(first);

  // Run 2 has a fresh filesystem, restores only the uploaded artifact, and
  // retries the email without sending ntfy again.
  const restored = validateDeliveryState(uploadedBytes);
  assert.deepEqual(pendingChannels(restored, "open:123", destinations), ["email"]);
  recordDeliveryResults(restored, "open:123", { email: HASH_B }, [{ channel: "email", ok: true }]);
  assert.deepEqual(pendingChannels(validateDeliveryState(JSON.stringify(restored)), "open:123", destinations), []);
});

test("corrupt state is rejected before a fresh runner can send notifications", () => {
  const valid = { version: 2, namespace: HASH_A, delivered: { "open:123": { ntfy: HASH_B } } };
  assert.deepEqual(validateDeliveryState(JSON.stringify(valid)), valid);
  for (const invalid of [
    "not json",
    JSON.stringify({ ...valid, version: 1 }),
    JSON.stringify({ ...valid, namespace: "wrong" }),
    JSON.stringify({ ...valid, delivered: { "open:123": { ntfy: "not-a-hash" } } }),
    JSON.stringify({ ...valid, delivered: { "unknown": { ntfy: HASH_B } } }),
  ]) {
    assert.throws(() => validateDeliveryState(invalid), /Private delivery state/);
  }
});

test("missing prior artifact starts empty; listing/API failures do not masquerade as missing state", async () => {
  const empty = await findLatestStateArtifact({
    api: apiFrom({ artifacts: [], runs: new Map() }),
    repository: "owner/repo", branch: "main", currentRunId: 99,
  });
  assert.equal(empty, null);
  await assert.rejects(findLatestStateArtifact({
    api: async () => { throw new Error("API unavailable"); },
    repository: "owner/repo", branch: "main", currentRunId: 99,
  }), /API unavailable/);
});

test("only a complete and matching forecast/calendar/marker bundle can be published", async () => {
  const settings = JSON.parse(await readFile(new URL("../public/config.json", import.meta.url), "utf8"));
  const window = { start: NOW, end: NOW + 7200, minDewC: 1, maxPredictedRH: 50 };
  const ics = buildCalendar({ settings, windows: [window], timezone: "America/New_York", stampEpoch: NOW });
  const generatedAt = new Date(NOW * 1000).toISOString();
  const data = {
    generatedAt, timezone: "America/New_York", location: settings.location,
    status: {}, windows: [window], hours: [], forecastHours: [
      { t: NOW, tempC: 20, dewPointC: 5, rh: 50, precipProb: 0, precipMm: 0, windKmh: 2 },
    ],
  };
  const marker = { generatedAt, checkedAt: generatedAt };
  const bundle = { json: JSON.stringify(data), ics, status: JSON.stringify(marker),
    files: ["windows.json", "windows.ics", "check-status.json"] };
  assert.deepEqual(validatePublicBundle(bundle), { generatedAt, checkedAt: generatedAt, legacy: false });
  assert.throws(() => validatePublicBundle({ ...bundle, files: [...bundle.files, "state.json"] }), /directory/);
  assert.throws(() => validatePublicBundle({ ...bundle, status: JSON.stringify({ ...marker, generatedAt: "2026-09-01T00:00:00.000Z" }) }), /matching/);
  assert.throws(() => validatePublicBundle({ ...bundle, ics: ics.replace("DTSTART:", "DTSTRT:") }), /matching/);
  assert.throws(() => validatePublicBundle({ ...bundle, json: JSON.stringify({ ...data, windows: [] }) }), /events/);
  assert.throws(() => validatePublicBundle({ ...bundle, json: JSON.stringify({ ...data, forecastHours: undefined }) }), /matching/);
});

test("failed checker fallback discards partial and ignored files, then verifies tracked last-good data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ow-actions-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await mkdir(join(dir, "public/data"), { recursive: true });
  const settings = JSON.parse(await readFile(new URL("../public/config.json", import.meta.url), "utf8"));
  const generatedAt = new Date(NOW * 1000).toISOString();
  const hour = { t: NOW, tempC: 20, dewPointC: 5, rh: 50, precipProb: 0, precipMm: 0, windKmh: 2 };
  const original = {
    json: JSON.stringify({ generatedAt, timezone: "America/New_York", location: settings.location,
      status: {}, windows: [], hours: [], forecastHours: [hour] }),
    ics: buildCalendar({ settings, windows: [], timezone: "America/New_York", stampEpoch: NOW }),
    status: JSON.stringify({ generatedAt, checkedAt: generatedAt }),
  };
  await Promise.all([
    writeFile(join(dir, "public/data/windows.json"), original.json),
    writeFile(join(dir, "public/data/windows.ics"), original.ics),
    writeFile(join(dir, "public/data/check-status.json"), original.status),
  ]);
  git("add", "public/data");
  git("commit", "-qm", "last good");

  // Simulate a crashed checker leaving a replaced JSON and temporary/ignored
  // files. The exact workflow fallback must restore the committed bundle.
  await writeFile(join(dir, "public/data/windows.json"), "{partial");
  await writeFile(join(dir, "public/data/windows.ics.partial.tmp"), "partial");
  await writeFile(join(dir, "public/data/state.json"), "should never enter Pages");
  await writeFile(join(dir, ".gitignore"), "public/data/state.json\n");
  git("restore", "--", "public/data");
  git("clean", "-fdx", "--", "public/data");
  const files = await readdir(join(dir, "public/data"));
  assert.deepEqual(files.sort(), ["check-status.json", "windows.ics", "windows.json"]);
  const [json, ics, status] = await Promise.all(["windows.json", "windows.ics", "check-status.json"]
    .map((name) => readFile(join(dir, "public/data", name), "utf8")));
  assert.deepEqual(validatePublicBundle({ json, ics, status, files }),
    { generatedAt, checkedAt: generatedAt, legacy: false });
});

test("code push allows only the known two-file legacy pair or a complete current bundle", async () => {
  // A fixed legacy fixture must stay valid when the deployed forecast advances.
  const settings = JSON.parse(await readFile(new URL("../public/config.json", import.meta.url), "utf8"));
  const timezone = "America/New_York";
  const windows = [{ start: NOW, end: NOW + 7200, minDewC: 1, maxPredictedRH: 50 }];
  const json = JSON.stringify({ generatedAt: new Date(NOW * 1000).toISOString(),
    timezone, location: settings.location, status: {}, windows, hours: [] });
  const ics = buildCalendar({ settings, windows, timezone, stampEpoch: NOW });
  const pair = { json, ics, status: undefined, files: ["windows.json", "windows.ics"] };
  assert.equal(validatePublicBundle({ ...pair, allowLegacy: true }).legacy, true);
  assert.throws(() => validatePublicBundle(pair), /incomplete/);
  assert.throws(() => validatePublicBundle({ ...pair, files: [...pair.files, "state.json"],
    allowLegacy: true }), /unexpected/);
  assert.throws(() => validatePublicBundle({ ...pair, files: [...pair.files, "windows.json.tmp"],
    allowLegacy: true }), /unexpected/);
  const newDataWithoutMarker = JSON.stringify({ ...JSON.parse(json), forecastHours: [] });
  assert.throws(() => validatePublicBundle({ ...pair, json: newDataWithoutMarker,
    allowLegacy: true }), /matching/);
});

test("Pages tree rejects private state, temporary files, and symlink escapes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ow-pages-tree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "data"));
  await validatePagesTree(dir);
  await writeFile(join(dir, "data", "state.json"), "{}");
  await assert.rejects(validatePagesTree(dir), /private, temporary, or linked/);
  await rm(join(dir, "data", "state.json"));
  await writeFile(join(dir, "data", "windows.json.bak"), "old");
  await assert.rejects(validatePagesTree(dir), /private, temporary, or linked/);
  await rm(join(dir, "data", "windows.json.bak"));
  const { symlink } = await import("node:fs/promises");
  await symlink("/tmp", join(dir, "data", "outside"));
  await assert.rejects(validatePagesTree(dir), /private, temporary, or linked/);
});

test("Pages workflow keeps testing and private-state upload ahead of deployment", async () => {
  const yaml = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(yaml, /build-deploy:\s*\n\s*needs: test\s*\n\s*if: github\.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /actions: read/);
  assert.match(yaml, /uses: actions\/upload-artifact@v4[\s\S]*?path: \.state\/state\.json/);
  assert.match(yaml, /name: checker-delivery-state-v2-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(yaml, /uses: actions\/download-artifact@v4\s*\n\s*with:\s*\n\s*name: \$\{\{ steps\.previous-state\.outputs\.artifact_name \}\}\s*\n\s*run-id: \$\{\{ steps\.previous-state\.outputs\.run_id \}\}[\s\S]*?path: \.state/);
  assert.doesNotMatch(yaml, /artifact-ids:/);
  assert.match(yaml, /name: Verify complete Pages data bundle\s*\n\s*id: bundle\s*\n\s*run: node scripts\/actions-state\.mjs verify-public\s*\n\s*env:\s*\n\s*ALLOW_LEGACY_PUSH: \$\{\{ github\.event_name == 'push' \}\}/);
  assert.match(yaml, /uses: actions\/upload-pages-artifact@v3\s*\n\s*with:\s*\n\s*path: public/);
  assert.ok(yaml.indexOf("Save private delivery state") < yaml.indexOf("Commit verified updated data"));
  assert.ok(yaml.indexOf("Verify current main before checker work") < yaml.indexOf("Select previous private delivery state"));
  assert.ok(yaml.indexOf("Commit verified updated data") < yaml.indexOf("Verify current main before Pages publication"));
  assert.ok(yaml.indexOf("Verify current main before Pages publication") < yaml.indexOf("Configure Pages"));
  assert.ok(yaml.indexOf("Verify complete Pages data bundle") < yaml.indexOf("Upload Pages artifact"));
  assert.doesNotMatch(yaml, /if: always\(\)/);
});
