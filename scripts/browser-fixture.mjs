#!/usr/bin/env node
// Manual browser acceptance harness. Only loopback; never contacts a weather
// provider or notification channel. Kept outside the deployed public tree.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createStaticHandler } from "./serve.mjs";
import { planForecast } from "../public/core/windows.js";
import { buildCalendar } from "../public/core/calendar.js";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const settings = JSON.parse(await readFile(new URL("../public/config.json", import.meta.url), "utf8"));
settings.location = { lat: 40.7, lon: -74, label: "Fixture home" };
const now = Date.UTC(2026, 8, 23, 13, 15) / 1000;
const hours = Array.from({ length: 85 }, (_, index) => ({
  t: now - 900 + (index - 12) * 3600,
  tempC: 18, dewPointC: index % 18 < 12 ? 1 : 15,
  rh: 55, precipProb: 0, precipMm: 0, windKmh: 8,
}));
const plan = planForecast(hours, settings, now);
const generatedAt = new Date((now - 3600) * 1000).toISOString();
const data = { generatedAt, location: settings.location, timezone: "America/New_York", forecastHours: hours, ...plan };
const payload = { timezone: data.timezone, hourly: { time: hours.map(h => h.t) } };
for (const [remote, key] of Object.entries({ temperature_2m: "tempC", dew_point_2m: "dewPointC", relative_humidity_2m: "rh", precipitation_probability: "precipProb", precipitation: "precipMm", wind_speed_10m: "windKmh" })) {
  payload.hourly[remote] = hours.map(h => h[key]);
}
const fixture = { settings, now, payload, data, marker: { generatedAt, checkedAt: generatedAt },
  ics: buildCalendar({ settings, windows: plan.windows, timezone: data.timezone, stampEpoch: now }) };

function bootstrap(blockStorage, expandDetails) {
  return `<script>
  (() => {
    const fixture = ${JSON.stringify(fixture).replaceAll("<", "\\u003c")};
    ${expandDetails ? `const expand = () => document.querySelectorAll('main details').forEach(node => { node.open = true; });
    expand(); new MutationObserver(expand).observe(document.querySelector('main'), { childList: true, subtree: true });` : ""}
    const NativeDate = Date; let clock = fixture.now * 1000, offline = false;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    const tickers = [], nativeInterval = window.setInterval;
    window.setInterval = (fn, ms, ...args) => ms === 60000
      ? (tickers.push(() => fn(...args)), 9000 + tickers.length) : nativeInterval(fn, ms, ...args);
    const keys = ['openwindow.settings', 'openwindow.lastForecast'];
    document.querySelector('#qa-clear').onclick = () => {
      keys.forEach(key => localStorage.removeItem(key)); location.href = location.pathname;
    };
    ${blockStorage ? "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Fixture storage denied', 'SecurityError'); } }); document.querySelector('#qa-clear').disabled = true;" : ""}
    document.querySelector('#qa-network').onclick = event => {
      offline = !offline; event.target.textContent = offline ? 'Go online' : 'Go offline';
      document.querySelector('#qa-state').textContent = offline ? 'Offline: next Refresh uses browser cache' : 'Online fixture';
    };
    document.querySelector('#qa-expire').onclick = () => {
      clock += 7 * 3600 * 1000; tickers.forEach(fn => fn());
      document.querySelector('#qa-state').textContent = 'Advanced 7 hours';
    };
    const response = (value, type = 'application/json') => Promise.resolve(new Response(
      type === 'application/json' ? JSON.stringify(value) : value, { headers: { 'Content-Type': type } }));
    window.fetch = resource => {
      const url = new URL(resource, document.baseURI);
      if (url.pathname.endsWith('/config.json') && url.origin === location.origin) return response(fixture.settings);
      if (offline) return Promise.reject(new Error('Fixture offline'));
      if (url.hostname === 'api.open-meteo.com') return response(fixture.payload);
      if (url.origin !== location.origin) return Promise.reject(new Error('External request blocked by fixture'));
      if (url.pathname.endsWith('/data/windows.json')) return response(fixture.data);
      if (url.pathname.endsWith('/data/check-status.json')) return response(fixture.marker);
      if (url.pathname.endsWith('/data/windows.ics')) return response(fixture.ics, 'text/calendar');
      return Promise.reject(new Error('Unexpected fixture request: ' + url.pathname));
    };
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      blob.text().then(text => { document.querySelector('#qa-download').textContent = text; });
      return createObjectURL(blob);
    };
  })();
  </script>`;
}

const controls = `<aside aria-label="Browser test controls" style="padding:12px;border-bottom:1px solid currentColor">
  <strong>Local fixture — no live weather requests</strong>
  <button id="qa-network">Go offline</button> <button id="qa-expire">Advance 7 hours</button>
  <button id="qa-clear">Clear fixture storage</button> <span id="qa-state">Online fixture</span>
  <details><summary>Last calendar download</summary><pre id="qa-download" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>
</aside>`;
const serve = createStaticHandler({ rootDir: root });
const server = createServer(async (req, res) => {
  try {
    // These paths exercise the exact same relative assets at root and subpaths.
    const url = new URL(req.url, "http://127.0.0.1:8082");
    const prefix = ["/Luften-Window/", "/blocked/"].find(path => url.pathname.startsWith(path));
    const pathname = prefix ? url.pathname.slice(prefix.length - 1) : url.pathname;
    if (pathname === "/" || pathname === "/index.html") {
      let html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
      html = html.replace("<body>", "<body>" + controls)
        .replace('<script type="module"', bootstrap(prefix === "/blocked/", url.searchParams.get("audit") === "expanded") + '<script type="module"');
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(html);
    } else {
      req.url = pathname; await serve(req, res);
    }
  } catch {
    res.writeHead(500).end("Fixture server error");
  }
});
server.listen(8082, "127.0.0.1", () => console.log("Browser fixture: http://127.0.0.1:8082/ (also /Luften-Window/ and /blocked/)"));
