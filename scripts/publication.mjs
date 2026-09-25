// Publish related static artifacts from fully staged files. The JSON file is
// renamed last so readers do not see a new forecast manifest before its feed.
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

async function readExisting(fs, path) {
  try {
    const content = await fs.readFile(path);
    return content == null ? null : String(content);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function cleanup(fs, paths, preserve = new Set()) {
  const errors = [];
  for (const path of paths) {
    if (preserve.has(path)) continue;
    try {
      await fs.unlink(path);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }
  return errors;
}

/**
 * Stage every changed artifact and its previous content before replacing any
 * final path. If a rename fails, earlier replacements are restored. The JSON
 * artifact is committed last by default; commitLastPath can override that.
 *
 * fs must provide readFile, writeFile, rename and unlink. mkdir is optional.
 * `artifacts` is an array of { path, content } with string content. The caller
 * chooses stable content for semantically unchanged runs before calling this.
 */
export async function publishArtifacts({
  fs,
  artifacts,
  token = randomUUID(),
  commitLastPath,
} = {}) {
  if (!fs || ["readFile", "writeFile", "rename", "unlink"].some((key) => typeof fs[key] !== "function")) {
    throw new TypeError("Publication filesystem requires readFile, writeFile, rename and unlink");
  }
  if (!Array.isArray(artifacts)) throw new TypeError("Publication artifacts must be an array");
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new TypeError("Publication token must contain only letters, numbers, hyphens or underscores");
  }

  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.path !== "string" || !artifact.path || typeof artifact.content !== "string") {
      throw new TypeError("Each publication artifact needs a path and string content");
    }
    if (seen.has(artifact.path)) throw new Error(`Duplicate publication path: ${artifact.path}`);
    seen.add(artifact.path);
  }
  if (commitLastPath !== undefined && !seen.has(commitLastPath)) {
    throw new Error("commitLastPath must name one of the publication artifacts");
  }

  const selected = [];
  for (const artifact of artifacts) {
    const previous = await readExisting(fs, artifact.path);
    if (previous !== artifact.content) {
      selected.push({
        ...artifact,
        previous,
        staged: `${artifact.path}.${token}.tmp`,
        backup: previous === null ? null : `${artifact.path}.${token}.bak`,
      });
    }
  }
  if (selected.length === 0) return { changed: false, published: [] };

  const lastPath = commitLastPath ?? selected.find((item) => item.path.endsWith(".json"))?.path;
  selected.sort((a, b) => Number(a.path === lastPath) - Number(b.path === lastPath));

  const temporaryPaths = [];
  try {
    for (const item of selected) {
      await fs.mkdir?.(dirname(item.path), { recursive: true });
      if (item.backup) {
        temporaryPaths.push(item.backup);
        await fs.writeFile(item.backup, item.previous);
      }
      temporaryPaths.push(item.staged);
      await fs.writeFile(item.staged, item.content);
    }
  } catch (error) {
    const cleanupErrors = await cleanup(fs, temporaryPaths);
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Publication staging and cleanup failed");
    throw error;
  }

  const committed = [];
  try {
    for (const item of selected) {
      await fs.rename(item.staged, item.path);
      committed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    const preserve = new Set();
    for (const item of committed.reverse()) {
      try {
        if (item.backup) await fs.rename(item.backup, item.path);
        else await fs.unlink(item.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        if (item.backup) preserve.add(item.backup);
      }
    }
    const cleanupErrors = await cleanup(fs, temporaryPaths, preserve);
    if (rollbackErrors.length || cleanupErrors.length) {
      throw new AggregateError([error, ...rollbackErrors, ...cleanupErrors], "Publication failed and rollback or cleanup was incomplete");
    }
    throw error;
  }

  const cleanupErrors = await cleanup(fs, temporaryPaths);
  const result = { changed: true, published: selected.map((item) => item.path) };
  if (cleanupErrors.length) result.cleanupErrors = cleanupErrors;
  return result;
}
