#!/usr/bin/env node
// GitHub Actions handoff for private delivery state and a complete Pages bundle.
// Artifact metadata comes from GitHub's REST API; the official artifact action
// performs the actual download so this script needs no ZIP dependency.

import { appendFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCalendarFeed } from "../public/core/calendar.js";
import { validateForecastHours } from "../public/ui/forecast-controller.js";

const ARTIFACT_PREFIX = "checker-delivery-state-v2-";
const SHA256 = /^[a-f0-9]{64}$/;
const EVENT = /^(?:open:\d+|close:\d+:\d+|digest:\d{4}-\d{2}-\d{2})$/;
const CHANNELS = new Set(["ntfy", "email", "discord", "telegram"]);
const MAX_STATE_BYTES = 128 * 1024;
const EXPECTED_DATA_FILES = new Set(["windows.json", "windows.ics", "check-status.json"]);
const LEGACY_DATA_FILES = new Set(["windows.json", "windows.ics"]);

/** A queued run or rerun must not publish an older checkout over current main. */
export function verifyCurrentMain({ cwd = process.cwd() } = {}) {
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let head;
  let remote;
  try {
    head = git("rev-parse", "HEAD");
    remote = git("ls-remote", "--exit-code", "origin", "refs/heads/main");
  } catch {
    throw new Error("Cannot verify current main revision; Pages publication is stopped");
  }
  if (remote !== `${head}\trefs/heads/main`) {
    throw new Error("Main has advanced beyond this checkout; start a new workflow from current main");
  }
  return head;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function iso(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Reject corruption rather than silently dropping previously confirmed sends. */
export function validateDeliveryState(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Private delivery state is missing or too large");
  }
  let state;
  try { state = JSON.parse(text); } catch { throw new Error("Private delivery state is not JSON"); }
  if (!record(state) || state.version !== 2 || !SHA256.test(state.namespace)
      || !record(state.delivered) || Object.keys(state.delivered).length > 100
      || (state.lastCheckedAt !== undefined && !iso(state.lastCheckedAt))) {
    throw new Error("Private delivery state has an invalid schema");
  }
  for (const [event, confirmations] of Object.entries(state.delivered)) {
    if (!EVENT.test(event) || !record(confirmations) || Object.keys(confirmations).length > 4) {
      throw new Error("Private delivery state has an invalid event");
    }
    for (const [channel, identity] of Object.entries(confirmations)) {
      if (!CHANNELS.has(channel) || typeof identity !== "string" || !SHA256.test(identity)) {
        throw new Error("Private delivery state has an invalid channel confirmation");
      }
    }
  }
  return state;
}

/** Select the newest immutable upload from a completed scheduled/manual attempt. */
export async function findLatestStateArtifact({ api, repository, branch, currentRunId, currentRunAttempt = 1 }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      || typeof branch !== "string" || !branch || !/^\d+$/.test(String(currentRunId))
      || !/^\d+$/.test(String(currentRunAttempt)) || Number(currentRunAttempt) < 1) {
    throw new Error("Invalid GitHub run context for delivery-state restore");
  }
  const base = `/repos/${repository}/actions`;
  const candidates = [];
  let exhausted = false;
  for (let page = 1; page <= 50; page++) {
    const response = await api(`${base}/artifacts?per_page=100&page=${page}`);
    if (!record(response) || !Array.isArray(response.artifacts)) {
      throw new Error("GitHub returned an invalid artifact listing");
    }
    candidates.push(...response.artifacts.filter((item) => {
      const name = typeof item?.name === "string" ? item.name : "";
      const match = /^checker-delivery-state-v2-(\d+)-(\d+)$/.exec(name);
      const fromCurrentEarlierAttempt = String(item.workflow_run?.id) === String(currentRunId)
        && match && Number(match[2]) < Number(currentRunAttempt);
      return match && name.startsWith(ARTIFACT_PREFIX) && item.expired === false
        && Number.isSafeInteger(item.id) && Number.isSafeInteger(item.workflow_run?.id)
        && String(item.workflow_run.id) === match[1]
        && item.workflow_run.head_branch === branch
        && (String(item.workflow_run.id) !== String(currentRunId) || fromCurrentEarlierAttempt)
        && timestamp(item.created_at);
    }));
    if (response.artifacts.length < 100) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) throw new Error("Too many artifacts to identify the latest state safely");
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  for (const artifact of candidates) {
    const run = await api(`${base}/runs/${artifact.workflow_run.id}`);
    const earlierAttemptOfCurrent = String(run?.id) === String(currentRunId)
      && Number(artifact.name.split("-").at(-1)) < Number(currentRunAttempt);
    if ((run?.status === "completed" || earlierAttemptOfCurrent)
        && run?.id === artifact.workflow_run.id
        && run.head_branch === branch && ["schedule", "workflow_dispatch"].includes(run.event)
        && typeof run.path === "string" && run.path.startsWith(".github/workflows/pages.yml@")) {
      // A run may fail after successfully uploading its delivery state. Its
      // artifact is still the newest confirmed ledger and must be restored.
      return { id: artifact.id, name: artifact.name, runId: run.id, createdAt: artifact.created_at };
    }
  }
  return null;
}

/** Check the full bundle, or the checked-in legacy pair on code-only pushes. */
export function validatePublicBundle({ json, ics, status, files, allowLegacy = false }) {
  const full = Array.isArray(files) && files.length === EXPECTED_DATA_FILES.size
    && files.every((name) => EXPECTED_DATA_FILES.has(name));
  const legacy = allowLegacy && Array.isArray(files) && files.length === LEGACY_DATA_FILES.size
    && files.every((name) => LEGACY_DATA_FILES.has(name)) && status === undefined;
  if (!full && !legacy) {
    throw new Error("Pages data directory is incomplete or contains unexpected files");
  }
  let data;
  let marker;
  try { data = JSON.parse(json); if (full) marker = JSON.parse(status); } catch {
    throw new Error("Pages forecast or check marker is not JSON");
  }
  if (!record(data) || !iso(data.generatedAt)
      || (full && (!record(marker) || !iso(marker.generatedAt) || !iso(marker.checkedAt)
        || marker.generatedAt !== data.generatedAt || marker.checkedAt < data.generatedAt
        || !validateForecastHours(data.forecastHours)))
      || (legacy && Object.hasOwn(data, "forecastHours"))
      || !Array.isArray(data.hours) || !Array.isArray(data.windows)
      || typeof data.timezone !== "string" || !data.timezone
      || !record(data.location) || !Number.isFinite(data.location.lat)
      || data.location.lat < -90 || data.location.lat > 90
      || !Number.isFinite(data.location.lon) || data.location.lon < -180 || data.location.lon > 180
      || !record(data.status)
      || !isCalendarFeed(ics)) {
    throw new Error("Pages forecast, calendar, and check marker are not a complete matching bundle");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: data.timezone }); }
  catch { throw new Error("Pages forecast timezone is invalid"); }
  const eventLines = ics.replace(/\r\n[ \t]/g, "").split("\r\n");
  const starts = eventLines.filter((line) => line.startsWith("DTSTART:"));
  const ends = eventLines.filter((line) => line.startsWith("DTEND:"));
  const utc = (epoch) => new Date(epoch * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  if (starts.length !== data.windows.length || ends.length !== data.windows.length
      || data.windows.some((window, index) => !record(window)
        || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end)
        || window.start >= window.end || starts[index] !== `DTSTART:${utc(window.start)}`
        || ends[index] !== `DTEND:${utc(window.end)}`)) {
    throw new Error("Pages calendar events do not match forecast windows");
  }
  return { generatedAt: data.generatedAt, checkedAt: marker?.checkedAt ?? null, legacy };
}

/** Prevent hidden state, partial publications, or symlink escapes in Pages. */
export async function validatePagesTree(root = "public", readDir = readdir) {
  const visit = async (directory) => {
    for (const entry of await readDir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === ".state" || entry.name === "state.json"
          || /(?:\.tmp|\.bak|~)$/.test(entry.name)) {
        throw new Error(`Pages tree contains a private, temporary, or linked path: ${entry.name}`);
      }
      if (entry.isDirectory()) await visit(`${directory}/${entry.name}`);
    }
  };
  await visit(root);
}

async function githubApi(pathname, env = process.env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required to restore state");
  const base = env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetchImpl(new URL(pathname, base), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${pathname}`);
  return response.json();
}

async function output(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main(command, env = process.env) {
  switch (command) {
    case "verify-revision":
      console.log(`Current main revision verified: ${verifyCurrentMain()}`);
      break;
    case "select": {
      const found = await findLatestStateArtifact({
        api: (path) => githubApi(path, env),
        repository: env.GITHUB_REPOSITORY,
        branch: env.GITHUB_REF_NAME,
        currentRunId: env.GITHUB_RUN_ID,
        currentRunAttempt: env.GITHUB_RUN_ATTEMPT,
      });
      await output("found", found ? "true" : "false", env);
      if (found) {
        await output("artifact_name", found.name, env);
        await output("run_id", found.runId, env);
        console.log(`Restoring delivery state artifact ${found.id} from completed run ${found.runId}`);
      } else {
        console.log("No prior delivery-state artifact; checker starts with empty state");
      }
      break;
    }
    case "validate-private":
      validateDeliveryState(await readFile(".state/state.json", "utf8"));
      console.log("Restored delivery state is valid");
      break;
    case "prepare-upload": {
      let content;
      try { content = await readFile(".state/state.json", "utf8"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (content !== undefined) validateDeliveryState(content);
      await output("has_state", content === undefined ? "false" : "true", env);
      console.log(content === undefined ? "Checker did not produce private state" : "Private state is ready to upload");
      break;
    }
    case "verify-public": {
      await validatePagesTree();
      const [json, ics, files] = await Promise.all([
        readFile("public/data/windows.json", "utf8"),
        readFile("public/data/windows.ics", "utf8"),
        readdir("public/data"),
      ]);
      const status = files.includes("check-status.json")
        ? await readFile("public/data/check-status.json", "utf8") : undefined;
      const bundle = validatePublicBundle({ json, ics, status, files,
        allowLegacy: env.ALLOW_LEGACY_PUSH === "true" });
      console.log(bundle.legacy
        ? `Legacy code-push Pages bundle: published ${bundle.generatedAt}; no checker fallback metadata`
        : `Complete Pages bundle: published ${bundle.generatedAt}, checked ${bundle.checkedAt}`);
      break;
    }
    default:
      throw new Error("Usage: node scripts/actions-state.mjs verify-revision|select|validate-private|prepare-upload|verify-public");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch((error) => {
    console.error(`actions-state: ${error.message || error}`);
    process.exitCode = 1;
  });
}
