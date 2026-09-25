#!/usr/bin/env node
// Zero-dependency static server for local development. Bind loopback unless
// HOST is explicitly set, and resolve every served file within public/.

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../public", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".ics": "text/calendar; charset=utf-8",
  ".png": "image/png",
};

class StaticHttpError extends Error {
  constructor(status) {
    super(`Static request failed with ${status}`);
    this.status = status;
  }
}

function inside(path, root) {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot));
}

function requestPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) throw new StaticHttpError(400);
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { throw new StaticHttpError(400); }
  if (pathname.includes("\0") || pathname.includes("\\")) throw new StaticHttpError(400);
  if (pathname.split("/").includes("..")) throw new StaticHttpError(403);
  if (pathname === "/data/state.json") throw new StaticHttpError(404);
  return pathname === "/" ? "/index.html" : pathname;
}

async function fileInfo(path) {
  try { return await stat(path); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new StaticHttpError(404);
    if (error?.code === "EACCES") throw new StaticHttpError(403);
    throw error;
  }
}

export async function resolveStaticFile(rawUrl, rootDir = DEFAULT_ROOT) {
  const pathname = requestPath(rawUrl);
  const root = await realpath(rootDir);
  let file = resolve(root, pathname.slice(1));
  if (!inside(file, root)) throw new StaticHttpError(403);
  let info = await fileInfo(file);
  if (info.isDirectory()) {
    file = join(file, "index.html");
    info = await fileInfo(file);
  }
  if (!info.isFile()) throw new StaticHttpError(404);
  const canonical = await realpath(file);
  if (!inside(canonical, root)) throw new StaticHttpError(403);
  return { path: canonical, pathname };
}

export function createStaticHandler({ rootDir = DEFAULT_ROOT, readFileImpl = readFile } = {}) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    try {
      const file = await resolveStaticFile(req.url, rootDir);
      const body = req.method === "HEAD" ? "" : await readFileImpl(file.path);
      const headers = { "Content-Type": MIME[extname(file.path)] || "application/octet-stream" };
      if (file.pathname.startsWith("/data/")) headers["Cache-Control"] = "no-store";
      res.writeHead(200, headers).end(body);
    } catch (error) {
      const status = error instanceof StaticHttpError ? error.status : 500;
      const message = { 400: "Bad request", 403: "Forbidden", 404: "Not found" }[status]
        || "Internal server error";
      res.writeHead(status, { "Content-Type": "text/plain" }).end(message);
    }
  };
}

export function serverAddress(env = process.env) {
  const host = env.HOST ?? "127.0.0.1";
  const rawPort = env.PORT ?? "8080";
  if (typeof host !== "string" || !host.trim() || /\s/.test(host)) throw new Error("Invalid HOST");
  if (!/^\d+$/.test(String(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return { host, port: Number(rawPort) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { host, port } = serverAddress();
  const server = createServer(createStaticHandler());
  server.on("error", (error) => {
    console.error(`OpenWindow dev server: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`OpenWindow dev server running at http://${host}:${port}`);
  });
}
