// Window decision logic. Shared by the browser app and the Node checker.

import { dewPoint, rhFrom } from "./psychro.js";

const HOUR_SECONDS = 3600;

// Machine-readable reason codes for an hour that is not OK.
export const REASONS = [
  "DEW_TOO_HIGH",
  "TOO_COLD",
  "TOO_HOT",
  "RAIN_LIKELY",
  "RAINING",
  "TOO_WINDY",
  "NO_DATA",
  "WINDOW_TOO_SHORT",
];

function assertNow(nowEpoch) {
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(new Date(nowEpoch * 1000).getTime())) {
    throw new Error("Current time must be a finite epoch timestamp");
  }
}

// Validate again at this boundary because cached hours can bypass the API parser.
function assertHours(hours) {
  if (!Array.isArray(hours)) throw new Error("Forecast hours must be an array");
  let previous;
  for (const hour of hours) {
    const t = hour?.t;
    if (!hour || typeof hour !== "object" || Array.isArray(hour)
        || !Number.isSafeInteger(t) || !Number.isFinite(new Date(t * 1000).getTime())
        || !Number.isFinite(new Date((t + HOUR_SECONDS) * 1000).getTime())) {
      throw new Error("Forecast hours must have valid epoch timestamps");
    }
    if (previous !== undefined && (t <= previous || (t - previous) % HOUR_SECONDS !== 0)) {
      throw new Error("Forecast hours must be ordered without duplicates or overlapping intervals");
    }
    previous = t;
  }
}

/**
 * Compute the dew-point limit (°C) below which opening windows keeps
 * indoor RH at or below the target.
 */
export function computeLimitC(settings) {
  const indoorTempC = settings.indoorTempC;
  const targetRH = settings.targetRH;
  let limit = dewPoint(indoorTempC, targetRH);

  if (settings.coldestSurfaceC != null && Number.isFinite(settings.coldestSurfaceC)) {
    limit = Math.min(limit, settings.coldestSurfaceC);
  }

  if (settings.requireDrying && settings.indoorReading) {
    const r = settings.indoorReading;
    if (r && Number.isFinite(r.tempC) && Number.isFinite(r.rh)) {
      const indoorDewPointC = dewPoint(r.tempC, r.rh);
      limit = Math.min(limit, indoorDewPointC);
    }
  }

  const margin = Number.isFinite(settings.marginC) ? settings.marginC : 0;
  return limit - margin;
}

function isOK(h, limitC, settings) {
  const reasons = [];

  const optionalNumber = (value, min = 0, max = Infinity) => value == null
    || (Number.isFinite(value) && value >= min && value <= max);
  if (!Number.isFinite(h.dewPointC) || !Number.isFinite(h.tempC) || !Number.isFinite(limitC)
      || !optionalNumber(h.rh, 0, 100) || !optionalNumber(h.precipProb, 0, 100)
      || !optionalNumber(h.precipMm) || !optionalNumber(h.windKmh)) {
    return { ok: false, reasons: ["NO_DATA"], predictedIndoorRH: null };
  }

  const predictedIndoorRH = rhFrom(settings.indoorTempC, h.dewPointC);
  if (!Number.isFinite(predictedIndoorRH)) {
    return { ok: false, reasons: ["NO_DATA"], predictedIndoorRH: null };
  }

  if (!(h.dewPointC <= limitC)) reasons.push("DEW_TOO_HIGH");
  if (h.tempC < settings.minOutdoorC) reasons.push("TOO_COLD");
  if (h.tempC > settings.maxOutdoorC) reasons.push("TOO_HOT");
  if (h.precipProb != null && h.precipProb > settings.maxRainProb) reasons.push("RAIN_LIKELY");
  if (h.precipMm != null && h.precipMm > 0.1) reasons.push("RAINING");
  if (h.windKmh != null && h.windKmh > settings.maxWindKmh) reasons.push("TOO_WINDY");

  return { ok: reasons.length === 0, reasons, predictedIndoorRH };
}

/**
 * Evaluate forecast hours into per-hour results.
 * @param {Array} hours normalized forecast hour objects
 * @param {object} settings merged settings (with indoorTempC etc.)
 * @param {number} [nowEpoch] exclude expired intervals; omit to evaluate full history
 */
export function evaluateHours(hours, settings, nowEpoch) {
  assertHours(hours);
  if (nowEpoch !== undefined) assertNow(nowEpoch);
  const limitC = computeLimitC(settings);
  const results = [];

  for (const h of hours) {
    if (nowEpoch !== undefined && h.t + HOUR_SECONDS <= nowEpoch) continue;
    const verdict = isOK(h, limitC, settings);
    results.push({
      ...h,
      ok: verdict.ok,
      reasons: verdict.reasons,
      predictedIndoorRH: verdict.predictedIndoorRH,
      limitC,
    });
  }

  return results;
}

/**
 * Group contiguous OK hours into windows.
 * Returns windows with start/end (epoch s, end = last OK + 3600) etc.
 */
export function groupWindows(evaluated, settings) {
  assertHours(evaluated);
  const windows = [];
  let current = null;

  for (const h of evaluated) {
    if (current && (h.ok !== true || h.t !== current.hours.at(-1).t + HOUR_SECONDS)) {
      windows.push(current);
      current = null;
    }
    if (h.ok === true) {
      if (!current) {
        current = { hours: [] };
      }
      current.hours.push(h);
    }
  }
  if (current) windows.push(current);

  const minHours = settings.minWindowHours;
  return windows
    .filter((w) => w.hours.length >= minHours)
    .map((w) => {
      const first = w.hours[0];
      const last = w.hours[w.hours.length - 1];
      let minDewC = Infinity;
      let maxPredictedRH = -Infinity;
      for (const h of w.hours) {
        if (Number.isFinite(h.dewPointC)) minDewC = Math.min(minDewC, h.dewPointC);
        if (Number.isFinite(h.predictedIndoorRH)) maxPredictedRH = Math.max(maxPredictedRH, h.predictedIndoorRH);
      }
      return {
        start: first.t,
        end: last.t + HOUR_SECONDS,
        hours: w.hours.length,
        minDewC: minDewC === Infinity ? null : minDewC,
        maxPredictedRH: maxPredictedRH === -Infinity ? null : maxPredictedRH,
      };
    });
}

/**
 * Current status given the evaluated hours and grouped windows.
 */
export function currentStatus(evaluated, windows, nowEpoch) {
  assertNow(nowEpoch);
  const nowHour = evaluated.find((h) => h.t <= nowEpoch && nowEpoch < h.t + HOUR_SECONDS) || null;
  // Find the window containing now (start <= now < end).
  const currentWindow = nowHour?.ok === true
    ? windows.find((w) => nowEpoch >= w.start && nowEpoch < w.end) || null
    : null;

  let openNow = false;
  let reasons = [];

  if (currentWindow) {
    openNow = true;
  } else {
    reasons = !nowHour ? ["NO_DATA"] : nowHour.ok === true ? ["WINDOW_TOO_SHORT"]
      : nowHour.reasons?.length ? [...nowHour.reasons] : ["NO_DATA"];
  }

  // Next window: the first one that starts after now.
  const nextWindow = windows.find((w) => w.start > nowEpoch) || null;

  return {
    openNow,
    reasons,
    currentWindow,
    nextWindow,
    closesAt: currentWindow ? currentWindow.end : null,
    remainingSeconds: currentWindow ? currentWindow.end - nowEpoch : null,
  };
}

/**
 * Plan from the full forecast before clipping display hours. A qualifying run
 * keeps its original identity and stays open through its final hourly interval.
 */
export function planForecast(hours, settings, nowEpoch) {
  assertNow(nowEpoch);
  const all = evaluateHours(hours, settings);
  const windows = groupWindows(all, settings).filter((window) => window.end > nowEpoch);
  const evaluated = all.filter((hour) => hour.t + HOUR_SECONDS > nowEpoch);
  return {
    evaluated,
    windows,
    status: currentStatus(evaluated, windows, nowEpoch),
    limitC: computeLimitC(settings),
  };
}
