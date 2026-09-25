// Open-Meteo forecast client. Shared by browser and Node.
// Only standard JS + fetch + Intl. Relative imports with .js.

import { dewPoint } from "./psychro.js";

/**
 * Build the Open-Meteo request URL from settings.
 */
export function buildUrl(settings) {
  const loc = settings.location || {};
  // Include enough earlier hours to keep a qualified run across local midnight.
  // Open-Meteo permits 0–92 past days; callers validate minWindowHours first.
  const pastDays = Math.min(92, Math.max(1, Math.ceil((settings.minWindowHours ?? 2) / 24)));
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly:
      "temperature_2m,dew_point_2m,relative_humidity_2m,precipitation_probability,precipitation,wind_speed_10m",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timezone: "auto",
    timeformat: "unixtime",
    forecast_days: String(settings.forecastDays ?? 3),
    past_days: String(pastDays),
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

const HOUR_SECONDS = 3600;
const MAX_DATE_SECONDS = 8640000000000;
const OBSERVATIONS = {
  temperature_2m: {},
  dew_point_2m: {},
  relative_humidity_2m: { min: 0, max: 100 },
  precipitation_probability: { min: 0, max: 100 },
  precipitation: { min: 0 },
  wind_speed_10m: { min: 0 },
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function observation(value, key, index) {
  if (value == null) return null;
  const { min = -Infinity, max = Infinity } = OBSERVATIONS[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid forecast hourly.${key}[${index}]: expected a finite number in range`);
  }
  return value;
}

/**
 * Normalize an Open-Meteo response into { timezone, hours: Hour[] }.
 * Each hour: { t, tempC, dewPointC, rh, precipProb, precipMm, windKmh }.
 * If the response gives null dew point for an hour, compute it from temp+RH;
 * if that's impossible, leave dewPointC null (caller marks NO_DATA).
 */
export function normalize(apiJson) {
  if (!isObject(apiJson)) throw new Error("Invalid forecast: expected an object");
  const { hourly, timezone } = apiJson;
  if (!isObject(hourly)) throw new Error("Invalid forecast hourly: expected an object");
  if (typeof timezone !== "string" || !timezone || /^[+-]/.test(timezone)) {
    throw new Error("Invalid forecast timezone: expected a named timezone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid forecast timezone: expected a supported named timezone");
  }

  const times = hourly.time;
  if (!Array.isArray(times) || times.length === 0) {
    throw new Error("Invalid forecast hourly.time: expected a nonempty array");
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!Number.isSafeInteger(t) || t < -MAX_DATE_SECONDS || t > MAX_DATE_SECONDS - HOUR_SECONDS) {
      throw new Error(`Invalid forecast hourly.time[${i}]: expected epoch seconds within the Date range`);
    }
    if (i > 0 && (t <= times[i - 1] || (t - times[i - 1]) % HOUR_SECONDS !== 0)) {
      throw new Error("Invalid forecast hourly.time: timestamps must increase by whole hours");
    }
  }

  const arrays = {};
  for (const key of Object.keys(OBSERVATIONS)) {
    const values = Object.hasOwn(hourly, key) ? hourly[key] : [];
    if (!Array.isArray(values)) throw new Error(`Invalid forecast hourly.${key}: expected an array`);
    if (values.length > times.length) {
      throw new Error(`Invalid forecast hourly.${key}: array length exceeds hourly.time`);
    }
    arrays[key] = values;
  }

  const hours = [];
  for (let i = 0; i < times.length; i++) {
    const values = {};
    for (const key of Object.keys(OBSERVATIONS)) values[key] = observation(arrays[key][i], key, i);
    const tempC = values.temperature_2m;
    const rh = values.relative_humidity_2m;
    let dewPointC = values.dew_point_2m;
    if (dewPointC === null && tempC !== null && rh !== null && rh > 0) {
      const derived = dewPoint(tempC, rh);
      if (Number.isFinite(derived)) dewPointC = derived;
    }
    hours.push({
      t: times[i],
      tempC,
      dewPointC,
      rh,
      precipProb: values.precipitation_probability,
      precipMm: values.precipitation,
      windKmh: values.wind_speed_10m,
    });
  }
  if (!hours.some((hour) => hour.tempC !== null && hour.dewPointC !== null)) {
    throw new Error("Invalid forecast: no usable temperature and dew point coverage");
  }
  return { timezone, hours };
}

const TIMEOUT_MS = 10000;

/**
 * Fetch and normalize the forecast, injecting fetchImpl, clock, and timers for tests.
 * The deadline covers both the request and response body, even if fetch ignores abort.
 * @returns {Promise<{timezone, hours, fetchedAt}>}
 */
export async function fetchForecast(settings, fetchImpl = fetch, {
  timeoutMs = TIMEOUT_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Forecast timeoutMs must be a positive finite number");
  }
  const url = buildUrl(settings);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => {
      reject(new Error(`Forecast request timed out after ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const request = (async () => {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Open-Meteo returned HTTP ${res.status}`);
      const json = await res.json();
      const { timezone, hours } = normalize(json);
      return { timezone, hours, fetchedAt: Math.floor(now() / 1000) };
    })();
    return await Promise.race([request, deadline]);
  } catch (err) {
    throw new Error(`Failed to fetch forecast from Open-Meteo: ${err?.message || err}`);
  } finally {
    clearTimer(timer);
  }
}
