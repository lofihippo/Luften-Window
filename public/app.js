// Luften Window UI entry point. ES module, no dependencies.

import { mergeSettings, validate, toQuery, fromQuery } from "./core/settings.js";
import { fetchForecast } from "./core/forecast.js";
import { cToF } from "./core/psychro.js";
import { buildCalendar, isCalendarFeed } from "./core/calendar.js";
import { settingsToFields, fieldsToSettings, convertTemperatureFields } from "./ui/settings-form.js";
import { readPreferences, writePreferences, clearPreferences } from "./ui/preferences.js";
import { formatForecastRange } from "./ui/forecast-time.js";
import { createForecastChart } from "./ui/forecast-chart.js";
import { createForecastController } from "./ui/forecast-controller.js";

const CACHE_KEY = "openwindow.lastForecast";

// ---------- Module state ----------
let defaults = null;
let settings = null;
let timezone = "UTC";
let evaluated = [];
let windows = [];
let formUnit = "";
let draftDirty = false;
let forecastController;

const $ = (id) => document.getElementById(id);
const forecastChart = createForecastChart($("chart"));
const setText = (id, value) => {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
};

// =========================================================================
// Settings loading (Section 6 order: config.json < localStorage < URL query)
// =========================================================================
async function loadConfig() {
  const res = await fetch("./config.json");
  if (!res.ok) throw new Error("Failed to load config.json");
  const config = await res.json();
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config.json must contain a settings object");
  }
  return config;
}
function getSettings() {
  const stored = readPreferences();
  setSettingsFeedback(stored.notice);
  const query = fromQuery(new URLSearchParams(window.location.search));
  return mergeSettings(defaults, stored.settings, query);
}

// =========================================================================
// Persistence
// =========================================================================
function currentSettingsObject() {
  return {
    location: settings.location,
    units: settings.units,
    indoorTempC: settings.indoorTempC,
    targetRH: settings.targetRH,
    coldestSurfaceC: settings.coldestSurfaceC,
    marginC: settings.marginC,
    minOutdoorC: settings.minOutdoorC,
    maxOutdoorC: settings.maxOutdoorC,
    maxRainProb: settings.maxRainProb,
    maxWindKmh: settings.maxWindKmh,
    minWindowHours: settings.minWindowHours,
    requireDrying: settings.requireDrying,
    indoorReading: settings.indoorReading,
    forecastDays: settings.forecastDays,
  };
}
function updateUrl() {
  try {
    window.history.replaceState({}, "", shareUrl(settings));
    return true;
  } catch {
    return false;
  }
}
function shareUrl(value) {
  const url = new URL(window.location.href);
  url.search = toQuery(value);
  return url.toString();
}

// =========================================================================
// Unit conversion (internal always °C; display per settings.units)
// =========================================================================
function tempLabel(c, unit) {
  return unit === "F" ? `${Math.round(cToF(c))}°F` : `${Math.round(c)}°C`;
}
// =========================================================================
// Time formatting (use forecast timezone)
// =========================================================================
function fmtHour(epoch) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epoch * 1000));
}
function fmtRange(start, end) {
  return formatForecastRange(start, end, timezone);
}
function fmtDuration(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function remainingLabel(seconds) {
  if (seconds < 60) return "less than 1 minute remaining";
  return `${fmtDuration(Math.ceil(seconds / 60) / 60)} remaining`;
}
function formatIso(value, zone = timezone) {
  if (!value) return "unknown";
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
}

// =========================================================================
// Reason labels
// =========================================================================
const REASON_LABELS = {
  DEW_TOO_HIGH: "dew point too high",
  TOO_COLD: "too cold",
  TOO_HOT: "too hot",
  RAIN_LIKELY: "rain likely",
  RAINING: "raining",
  TOO_WINDY: "too windy",
  NO_DATA: "current forecast data is missing",
  WINDOW_TOO_SHORT: "dry period is shorter than your minimum window length",
};
function reasonsText(reasons) {
  if (!reasons || reasons.length === 0) return "";
  const labels = [...new Set(reasons.map((r) => REASON_LABELS[r] || r))];
  return `Because: ${labels.join(", ")}`;
}

// =========================================================================
// Banner
// =========================================================================
function renderLocation(ready = false) {
  const location = settings?.location;
  const coordinates = Number.isFinite(location?.lat) && Number.isFinite(location?.lon)
    ? `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}` : "Choose your location";
  setText("location-name", location?.label || coordinates);
  setText("location-timezone", ready ? `All times in ${timezone.replaceAll("_", " ")}`
    : "Times follow your forecast location.");
}

function renderBanner(status) {
  const banner = $("banner");
  let title, time = "", reason;
  if (status.openNow) {
    banner.className = "banner open";
    title = "Windows can be open";
    time = status.closesAt != null ? `Open until ${fmtHour(status.closesAt)}` : "Windows can be open";
    reason = Number.isFinite(status.remainingSeconds)
      ? `${remainingLabel(status.remainingSeconds)}. Conditions meet your humidity and weather limits.`
      : "Conditions meet your humidity and weather limits.";
  } else if (status.reasons.includes("NO_DATA")) {
    banner.className = "banner neutral";
    title = "Current conditions unavailable";
    time = status.nextWindow ? `Next window: ${fmtRange(status.nextWindow.start, status.nextWindow.end)}` : "";
    reason = "There is not enough current forecast data to recommend opening now.";
  } else {
    banner.className = "banner closed";
    title = "Keep windows closed";
    time = status.nextWindow ? `Next: ${fmtRange(status.nextWindow.start, status.nextWindow.end)}`
      : `No opening in the next ${Math.round(settings.forecastDays)} days`;
    reason = reasonsText(status.reasons);
  }
  setText("banner-title", title);
  setText("banner-time", time);
  $("banner-time").hidden = !time;
  setText("banner-sub", reason);
}

function renderConditions() {
  const now = Math.floor(Date.now() / 1000);
  const hour = evaluated.find((h) => h.t <= now && h.t + 3600 > now);
  $("conditions").hidden = !hour || !Number.isFinite(hour.tempC) || !Number.isFinite(hour.dewPointC);
  if ($("conditions").hidden) return;
  setText("metric-dew", tempLabel(hour.dewPointC, settings.units));
  setText("metric-limit", `Your dew-point limit: ${tempLabel(hour.limitC, settings.units)}`);
  setText("metric-rh-label", `RH at ${tempLabel(settings.indoorTempC, settings.units)} indoors`);
  setText("metric-rh", Number.isFinite(hour.predictedIndoorRH) ? `${Math.round(hour.predictedIndoorRH)}%` : "—");
  setText("metric-target", `Your humidity target: ${settings.targetRH}%`);
}

// Keep calendar buttons mounted through minute ticks and late metadata updates.
function syncChildren(parent, children) {
  for (const [index, child] of children.entries()) {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
  }
  for (const child of [...parent.children]) if (!children.includes(child)) child.remove();
}
function renderWindows(status) {
  const list = $("windows-list");
  const later = $("later-windows-list");
  const active = document.activeElement;
  const focusedCalendar = list.contains(active) || later.contains(active) ? active : null;
  const existing = new Map([...list.children, ...later.children].map((node) => [node.dataset.start, node]));
  const cards = windows.map((w, index) => {
    let li = existing.get(String(w.start));
    if (!li) {
      li = document.createElement("li");
      li.dataset.start = String(w.start);
      li.innerHTML = '<p class="window-kicker"></p><h3 class="window-title"></h3><p class="window-meta"></p><div class="window-bottom"><p class="window-duration"></p><button type="button" class="btn secondary small">Add to calendar</button></div>';
      li.querySelector("button").addEventListener("click", () => downloadIcs(li.windowData));
    }
    li.windowData = w;
    li.className = `window-item${index === 0 ? " featured" : ""}`;
    const current = w.start === status.currentWindow?.start;
    const kicker = li.querySelector(".window-kicker");
    kicker.textContent = current ? "Open now" : "Next opportunity";
    kicker.hidden = index !== 0;
    li.querySelector(".window-title").textContent = fmtRange(w.start, w.end);
    const bits = [];
    if (w.minDewC != null) bits.push(`Lowest dew point ${tempLabel(w.minDewC, settings.units)}`);
    if (w.maxPredictedRH != null) bits.push(`Outdoor-air RH up to ${Math.round(w.maxPredictedRH)}% at ${tempLabel(settings.indoorTempC, settings.units)}`);
    li.querySelector(".window-meta").textContent = bits.join(" · ");
    li.querySelector(".window-duration").textContent = current && Number.isFinite(status.remainingSeconds)
      ? `${remainingLabel(status.remainingSeconds)} · ${fmtDuration(w.hours)} total` : `${fmtDuration(w.hours)} window`;
    li.querySelector("button").setAttribute("aria-label", `Add to calendar: ${fmtRange(w.start, w.end)}`);
    return li;
  });
  syncChildren(list, cards.slice(0, 3));
  syncChildren(later, cards.slice(3));
  $("more-windows").hidden = cards.length <= 3;
  const extra = Math.max(0, cards.length - 3);
  setText("more-windows-summary", `View ${extra} more ${extra === 1 ? "window" : "windows"}`);
  $("windows-empty").hidden = windows.length !== 0;
  setText("windows-empty", `No suitable window in the next ${settings.forecastDays} days. Try a longer forecast or review your limits in settings.`);
  setText("windows-count", `${windows.length} ${windows.length === 1 ? "window" : "windows"}`);
  if (focusedCalendar && document.activeElement !== focusedCalendar) {
    const target = focusedCalendar.isConnected ? focusedCalendar : cards[0]?.querySelector("button") || $("windows-heading");
    if (target.closest("#more-windows")) $("more-windows").open = true;
    target.focus({ preventScroll: true });
  }
}

// =========================================================================
// .ics export (Section 6 + 13)
// =========================================================================
function downloadIcs(w) {
  const contents = buildCalendar({ settings, windows: [w], timezone,
    stampEpoch: Math.floor(Date.now() / 1000) });
  const blob = new Blob([contents], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "luften-window.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// =========================================================================
// Settings panel
// =========================================================================
const INPUT_IDS = [
  "lat", "lon", "label", "indoor-temp", "target-rh", "coldest-surface", "margin",
  "min-outdoor", "max-outdoor", "max-rain", "max-wind", "min-window-hours",
  "forecast-days", "indoor-reading-temp", "indoor-reading-rh",
];
const ERROR_FIELDS = {
  "location": "lat", "location.lat": "lat", "location.lon": "lon", "location.label": "label",
  units: "units-f", indoorTempC: "indoor-temp", targetRH: "target-rh",
  coldestSurfaceC: "coldest-surface", marginC: "margin", minOutdoorC: "min-outdoor",
  maxOutdoorC: "max-outdoor", maxRainProb: "max-rain", maxWindKmh: "max-wind",
  minWindowHours: "min-window-hours", forecastDays: "forecast-days", requireDrying: "require-drying",
  indoorReading: "indoor-reading-temp", "indoorReading.tempC": "indoor-reading-temp",
  "indoorReading.rh": "indoor-reading-rh",
};
function readFormFields() {
  const fields = Object.fromEntries(INPUT_IDS.map((id) => [id, $(id).value]));
  fields.units = $("units-f").checked ? "F" : $("units-c").checked ? "C" : "";
  fields["require-drying"] = $("require-drying").checked;
  return fields;
}
function fillFormFields(fields) {
  for (const id of INPUT_IDS) $(id).value = fields[id];
  $("units-f").checked = fields.units === "F";
  $("units-c").checked = fields.units === "C";
  $("require-drying").checked = fields["require-drying"];
  $("indoor-reading-fields").hidden = !fields["require-drying"];
  // Invalid saved units are displayed as Celsius until a unit is selected.
  formUnit = fields.units || "C";
  document.querySelectorAll("[data-temperature-unit]").forEach((label) => {
    label.textContent = `°${formUnit}`;
  });
}
function fillSettingsForm() {
  fillFormFields(settingsToFields(settings));
  draftDirty = false;
  $("settings-dirty").hidden = true;
  $("draft-note").hidden = true;
}
function readSettingsForm() {
  return fieldsToSettings(readFormFields());
}
function setSettingsFeedback(message) {
  setText("settings-feedback", message);
}
function markDraftChanged() {
  draftDirty = true;
  $("settings-dirty").hidden = false;
  $("draft-note").hidden = false;
  setSettingsFeedback("Unsaved changes. Save to update your forecast, or copy a link to share this form.");
}
function onUnitsChange() {
  const fields = readFormFields();
  const converted = convertTemperatureFields(fields, formUnit, fields.units);
  fillFormFields(converted);
  markDraftChanged();
}
function fieldErrorMessage(field, fallback) {
  const temperatureRange = formUnit === "F" ? "−148°F and 212°F" : "−100°C and 100°C";
  const temperature = `Enter a temperature between ${temperatureRange}.`;
  const messages = {
    location: "Enter a latitude and longitude.",
    "location.lat": "Enter a latitude between −90 and 90.",
    "location.lon": "Enter a longitude between −180 and 180.",
    "location.label": "Enter a location name using text.",
    units: "Choose Fahrenheit or Celsius.",
    indoorTempC: temperature, coldestSurfaceC: temperature, maxOutdoorC: temperature,
    minOutdoorC: fallback.includes("< maxOutdoorC") ? "The minimum temperature must be lower than the maximum." : temperature,
    targetRH: "Enter a target humidity between 20% and 80%.",
    marginC: "Enter a safety margin of 0°C or more.",
    maxRainProb: "Enter a rain chance between 0% and 100%.",
    maxWindKmh: "Enter a wind limit of 0 km/h or more.",
    minWindowHours: "Enter a whole number of hours, at least 1.",
    forecastDays: "Enter a whole number of days, from 1 to 16.",
    requireDrying: "Choose whether to require drier air.",
    indoorReading: "Enter both indoor temperature and humidity, or leave both blank.",
    "indoorReading.tempC": temperature,
    "indoorReading.rh": "Enter indoor humidity greater than 0% and at most 100%.",
  };
  return messages[field] || fallback;
}
function showErrors(result, { focus = false } = {}) {
  const errors = Array.isArray(result) ? result : result.errors;
  const fieldErrors = result.fieldErrors || {};
  const box = $("settings-errors");
  document.querySelectorAll(".field-error").forEach((error) => error.remove());
  for (const id of new Set(Object.values(ERROR_FIELDS))) {
    const input = $(id);
    input.removeAttribute("aria-invalid");
    const descriptions = (input.getAttribute("aria-describedby") || "").split(/\s+/)
      .filter((value) => value && !value.startsWith("field-error-") && value !== "settings-errors");
    if (descriptions.length) input.setAttribute("aria-describedby", descriptions.join(" "));
    else input.removeAttribute("aria-describedby");
  }
  box.replaceChildren();
  box.hidden = !errors?.length;
  if (box.hidden) return;
  const heading = document.createElement("p");
  heading.textContent = "A few settings need your attention.";
  const ul = document.createElement("ul");
  for (const e of errors) {
    const field = Object.keys(fieldErrors).find((key) => fieldErrors[key] === e);
    const li = document.createElement("li"); li.textContent = fieldErrorMessage(field, e); ul.appendChild(li);
  }
  box.append(heading, ul);
  let firstInput;
  for (const [field, message] of Object.entries(fieldErrors)) {
    const input = $(ERROR_FIELDS[field]);
    if (!input) continue;
    input.setAttribute("aria-invalid", "true");
    const id = `field-error-${input.id}`;
    let error = $(id);
    if (!error) {
      error = document.createElement("span"); error.id = id; error.className = "field-error";
      input.closest("label").appendChild(error);
    }
    error.textContent = fieldErrorMessage(field, Array.isArray(message) ? message.join(" ") : message);
    const descriptions = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    descriptions.add(id);
    input.setAttribute("aria-describedby", [...descriptions].join(" "));
    if (input.closest("#indoor-reading-fields")) $("indoor-reading-fields").hidden = false;
    for (let details = input.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
    firstInput ||= input;
  }
  $("settings-panel").open = true;
  if (focus) (firstInput || box).focus();
}
function validatedDraft() {
  const merged = mergeSettings(defaults, readSettingsForm());
  const result = validate(merged);
  showErrors(result, { focus: !result.ok });
  if (!result.ok) {
    setSettingsFeedback("Correct the highlighted settings. Your saved forecast settings have not changed.");
    return null;
  }
  return merged;
}
function renderInvalidSettings(result) {
  forecastController?.invalidate();
  clearForecastView("Correct your settings to see the hourly forecast.");
  renderLocation();
  $("banner").className = "banner neutral";
  setText("banner-title", "Check your settings");
  setText("banner-sub", "Correct the highlighted values to load your forecast.");
  setText("banner-source", "Forecast paused until settings are valid");
  $("refresh-btn").disabled = true;
  $("data-notice").hidden = true;
  setText("last-updated", "");
  $("checker-info").hidden = true;
  showErrors(result);
}

function onSave() {
  const merged = validatedDraft();
  if (!merged) return;
  settings = merged;
  const stored = writePreferences(currentSettingsObject());
  const linked = updateUrl();
  fillSettingsForm();
  setSettingsFeedback(stored ? "Settings saved." : "Settings applied for this visit. Browser storage is unavailable; keep a share link to restore them later.");
  if (!linked) setSettingsFeedback($("settings-feedback").textContent + " The address bar could not be updated.");
  loadAndRender();
}
function onReset() {
  const cleared = clearPreferences();
  settings = mergeSettings(defaults);
  fillSettingsForm();
  const linked = updateUrl();
  showErrors(validate(settings));
  setSettingsFeedback(cleared ? "Default settings restored." : "Defaults applied for this visit. Browser storage could not be cleared; keep a share link to preserve these defaults.");
  if (!linked) setSettingsFeedback($("settings-feedback").textContent + " The address bar could not be updated.");
  loadAndRender();
}
async function onShare() {
  const draft = validatedDraft();
  if (!draft) return;
  const copied = await copyText(shareUrl(draft));
  setSettingsFeedback((copied ? "Share link copied for the current form." : "Share link shown for manual copying.") +
    (draftDirty ? " These changes have not been saved." : ""));
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copy this link:", text);
    return false;
  }
}

// =========================================================================
// Data flow (Section 6)
// =========================================================================
async function readStatic(path, readBody) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(path, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return await readBody(res);
  } finally {
    clearTimeout(timeout);
  }
}
async function loadFallback() {
  return readStatic("./data/windows.json", (res) => res.json());
}
async function loadCheckStatus() {
  return readStatic("./data/check-status.json", (res) => res.json());
}
async function calendarFeedAvailable() {
  return readStatic("./data/windows.ics", async (res) => {
    const text = await res.text();
    return isCalendarFeed(text);
  });
}
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeCache(obj) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function loadAndRender() {
  const validation = validate(settings);
  if (!validation.ok) {
    renderInvalidSettings(validation);
    return;
  }
  $("refresh-btn").disabled = false;
  void forecastController.refresh(settings);
}

function clearForecastView(message = "A current forecast is needed to explore the hours ahead.") {
  evaluated = [];
  windows = [];
  timezone = "UTC";
  $("windows-list").replaceChildren();
  $("later-windows-list").replaceChildren();
  $("more-windows").hidden = true;
  $("windows-empty").hidden = false;
  setText("windows-empty", "Opening windows will appear when a forecast is available.");
  setText("windows-count", "");
  $("conditions").hidden = true;
  $("banner-time").hidden = true;
  forecastChart.clear(message);
  $("calendar-sub").hidden = true;
}

function renderForecastState(view) {
  const notice = $("data-notice");
  notice.hidden = true;
  $("refresh-btn").disabled = view.phase === "loading";
  setText("refresh-btn", view.phase === "loading" ? "Refreshing…" : "Refresh");
  if (view.phase !== "ready") {
    clearForecastView();
    renderLocation();
    setText("banner-source", view.phase === "loading" ? "Checking for a fresh forecast" : "No current forecast available");
    $("banner").className = "banner neutral";
    $("banner-title").textContent = view.phase === "loading" ? "Loading forecast…" : "Forecast unavailable";
    $("banner-sub").textContent = view.phase === "loading"
      ? "Checking the latest weather data."
      : "There is no usable forecast for this location and time. Try refreshing.";
    if (view.phase === "unavailable" && view.error) {
      notice.hidden = false;
      notice.textContent = view.error;
    }
    renderFooter(view);
    return;
  }
  timezone = view.timezone;
  evaluated = view.evaluated;
  windows = view.windows;
  renderLocation(true);
  renderAll(view);
  if (view.source !== "live") {
    notice.hidden = false;
    const origin = view.source === "background" ? "shared background forecast" : "saved browser forecast";
    notice.textContent = `Live weather is unavailable. Showing ${origin} from ${formatIso(view.fetchedAt)}.`;
  }
}

// =========================================================================
// Render everything (banner, windows, chart, footer)
// =========================================================================
function renderAll(view) {
  renderBanner(view.status);
  renderWindows(view.status);
  renderConditions();
  forecastChart.update({ hours: evaluated, windows, settings, timezone, now: Math.floor(Date.now() / 1000) });
  const age = Math.max(0, Math.floor((Date.now() / 1000 - view.fetchedAt) / 60));
  const source = { live: "Live forecast", background: "Shared forecast", cache: "Saved forecast" }[view.source];
  setText("banner-source", `${source} · ${age < 1 ? "just updated" : age < 60 ? `${age} min old` : `${Math.floor(age / 60)}h ${age % 60}m old`}`);
  renderCalendarSub(view);
  renderFooter(view);
}

function renderFooter(view) {
  const upd = $("last-updated");
  if (view.phase === "ready") {
    const source = { live: "Live forecast fetched", background: "Shared forecast checked", cache: "Saved forecast fetched" }[view.source];
    upd.textContent = `${source}: ${formatIso(view.fetchedAt)} · coverage through ${formatIso(view.coverageEnd)}`;
  } else {
    upd.textContent = "";
  }
  const checker = $("checker-info");
  if (view.checker) {
    checker.hidden = false;
    const location = view.checker.location;
    const label = location.label || `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`;
    checker.textContent = `Shared background forecast for ${label} published ${formatIso(view.checker.publishedAt, view.checker.timezone)}.`;
  } else {
    checker.hidden = true;
  }
}

function renderCalendarSub(view) {
  const el = $("calendar-sub");
  if (!view.feedAvailable || !view.checker) {
    el.hidden = true;
    return;
  }
  const link = $("calendar-link");
  const httpUrl = new URL("./data/windows.ics", window.location.href);
  const webcal = "webcal://" + httpUrl.href.replace(/^https?:\/\//, "");
  link.href = webcal;
  const location = view.checker.location;
  const label = location.label || `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`;
  $("calendar-scope").textContent = `Shared background calendar for ${label}; it uses checker settings, not your personal settings.`;
  el.hidden = false;
}

// =========================================================================
// Events
// =========================================================================
function wireEvents() {
  $("refresh-btn").addEventListener("click", loadAndRender);
  $("location-btn").addEventListener("click", () => {
    $("settings-panel").open = true;
    $("label").focus();
  });
  $("settings-form").addEventListener("submit", (event) => { event.preventDefault(); onSave(); });
  $("settings-form").addEventListener("input", markDraftChanged);
  $("units-f").addEventListener("change", onUnitsChange);
  $("units-c").addEventListener("change", onUnitsChange);
  $("reset-btn").addEventListener("click", onReset);
  $("share-btn").addEventListener("click", onShare);
  $("use-location").addEventListener("click", useMyLocation);
  $("require-drying").addEventListener("change", (e) => {
    $("indoor-reading-fields").hidden = !e.target.checked;
  });
  $("calendar-copy").addEventListener("click", async () => {
    const copied = await copyText($("calendar-link").href);
    setText("calendar-feedback", copied ? "Shared calendar link copied." : "Calendar link shown for manual copying.");
  });

  setInterval(() => forecastController.tick(), 60 * 1000);
  setInterval(() => { if (!document.hidden) loadAndRender(); }, 30 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    forecastController.tick();
    if (!document.hidden) loadAndRender();
  });
}

function useMyLocation() {
  if (!navigator.geolocation) {
    setSettingsFeedback("Location access is unavailable. Enter your latitude and longitude above.");
    return;
  }
  $("use-location").disabled = true;
  setSettingsFeedback("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("lat").value = pos.coords.latitude.toFixed(4);
      $("lon").value = pos.coords.longitude.toFixed(4);
      $("use-location").disabled = false;
      markDraftChanged();
    },
    () => {
      $("use-location").disabled = false;
      setSettingsFeedback("Could not find your location. Enter coordinates manually, or check your browser's location permission.");
    },
    { timeout: 10000 }
  );
}

// =========================================================================
// Boot
// =========================================================================
async function boot() {
  try {
    defaults = await loadConfig();
  } catch (err) {
    $("banner-title").textContent = "Configuration error";
    $("banner-sub").textContent = String(err.message || err);
    clearForecastView("The app configuration could not be loaded.");
    setText("banner-source", "Reload the app to try again");
    $("settings-panel").hidden = true;
    $("location-btn").disabled = true;
    $("refresh-btn").disabled = false;
    setText("refresh-btn", "Reload app");
    $("refresh-btn").addEventListener("click", () => window.location.reload());
    return;
  }
  settings = getSettings();
  fillSettingsForm();
  forecastController = createForecastController({
    fetchLive: (snapshot) => fetchForecast(snapshot),
    fetchBackground: loadFallback,
    fetchCheckStatus: loadCheckStatus,
    checkFeed: calendarFeedAvailable,
    readCache,
    writeCache,
    onState: renderForecastState,
  });
  wireEvents();
  const res = validate(settings);
  if (!res.ok) {
    renderInvalidSettings(res);
    showErrors(res, { focus: true });
    return;
  }
  loadAndRender();
}

boot();
