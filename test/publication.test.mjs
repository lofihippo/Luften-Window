import test from "node:test";
import assert from "node:assert/strict";
import { publishArtifacts } from "../scripts/publication.mjs";

const JSON_PATH = "/virtual/public/data/windows.json";
const ICS_PATH = "/virtual/public/data/windows.ics";
const OLD = { [JSON_PATH]: "old json\n", [ICS_PATH]: "old calendar\r\n" };
const NEW = { [JSON_PATH]: "new json\n", [ICS_PATH]: "new calendar\r\n" };

function memoryFs({ initial = OLD, failWrite, failRenameAt } = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const renames = [];
  const unlinks = [];
  const directories = [];
  return {
    files, writes, renames, unlinks, directories,
    fs: {
      readFile: async (path) => files.get(path) ?? null,
      mkdir: async (path) => { directories.push(path); },
      writeFile: async (path, content) => {
        writes.push(path);
        if (failWrite?.(path)) throw new Error("stage write failed");
        files.set(path, content);
      },
      rename: async (from, to) => {
        renames.push([from, to]);
        if (renames.length === failRenameAt) throw new Error("rename failed");
        if (!files.has(from)) throw new Error(`missing source: ${from}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      unlink: async (path) => {
        unlinks.push(path);
        files.delete(path);
      },
    },
  };
}

const artifacts = [
  { path: JSON_PATH, content: NEW[JSON_PATH] },
  { path: ICS_PATH, content: NEW[ICS_PATH] },
];

test("publication stages both files and renames JSON last", async () => {
  const h = memoryFs();
  const result = await publishArtifacts({ fs: h.fs, artifacts, token: "success" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.published, [ICS_PATH, JSON_PATH]);
  assert.equal(h.files.get(JSON_PATH), NEW[JSON_PATH]);
  assert.equal(h.files.get(ICS_PATH), NEW[ICS_PATH]);
  assert.deepEqual(h.renames.slice(0, 2).map(([, to]) => to), [ICS_PATH, JSON_PATH]);
  assert.deepEqual([...h.files.keys()].sort(), [ICS_PATH, JSON_PATH].sort());
});

test("a late staging failure leaves both previous final files untouched", async () => {
  const h = memoryFs({ failWrite: (path) => path === `${JSON_PATH}.stage-fail.tmp` });
  await assert.rejects(
    publishArtifacts({ fs: h.fs, artifacts, token: "stage-fail" }),
    /stage write failed/,
  );
  assert.equal(h.files.get(JSON_PATH), OLD[JSON_PATH]);
  assert.equal(h.files.get(ICS_PATH), OLD[ICS_PATH]);
  assert.deepEqual(h.renames, []);
  assert.deepEqual([...h.files.keys()].sort(), [ICS_PATH, JSON_PATH].sort());
});

test("a failed second rename restores the first published file", async () => {
  const h = memoryFs({ failRenameAt: 2 });
  await assert.rejects(
    publishArtifacts({ fs: h.fs, artifacts, token: "rename-fail" }),
    /rename failed/,
  );
  assert.deepEqual(h.renames.map(([, to]) => to), [ICS_PATH, JSON_PATH, ICS_PATH]);
  assert.equal(h.files.get(JSON_PATH), OLD[JSON_PATH]);
  assert.equal(h.files.get(ICS_PATH), OLD[ICS_PATH]);
  assert.deepEqual([...h.files.keys()].sort(), [ICS_PATH, JSON_PATH].sort());
});

test("rollback removes a newly created file when the final rename fails", async () => {
  const h = memoryFs({ initial: { [JSON_PATH]: OLD[JSON_PATH] }, failRenameAt: 2 });
  await assert.rejects(
    publishArtifacts({ fs: h.fs, artifacts, token: "new-file-fail" }),
    /rename failed/,
  );
  assert.equal(h.files.get(JSON_PATH), OLD[JSON_PATH]);
  assert.equal(h.files.has(ICS_PATH), false);
  assert.deepEqual([...h.files.keys()], [JSON_PATH]);
});

test("unchanged content performs no filesystem mutations", async () => {
  const h = memoryFs({ initial: NEW });
  const result = await publishArtifacts({ fs: h.fs, artifacts, token: "unchanged" });
  assert.deepEqual(result, { changed: false, published: [] });
  assert.deepEqual(h.directories, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.renames, []);
  assert.deepEqual(h.unlinks, []);
});

test("publication refuses filesystems without rename and unlink", async () => {
  const h = memoryFs();
  delete h.fs.rename;
  await assert.rejects(publishArtifacts({ fs: h.fs, artifacts }), /rename and unlink/);
  assert.deepEqual(h.writes, []);
});
