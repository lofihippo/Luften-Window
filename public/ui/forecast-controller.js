// Browser forecast source selection. Keep request ownership and fallback rules
// independent of the DOM so delayed responses cannot publish stale advice.

import { mergeSettings } from "../core/settings.js";
import { planForecast } from "../core/windows.js";

const HOUR = 3600;
const FUTURE_SKEW = 5 * 60;
export const MAX_FORECAST_AGE = 6 * HOUR;
const OBSERVATIONS = {
  tempC: [-Infinity, Infinity],
  dewPointC: [-Infinity, Infinity],
  rh: [0, 100],
  precipProb: [0, 100],
  precipMm: [0, Infinity],
  windKmh: [0, Infinity],
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function timestamp(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function validLocation(location) {
  return isObject(location) && typeof location.lat === "number" && Number.isFinite(location.lat)
    && location.lat >= -90 && location.lat <= 90
    && typeof location.lon === "number" && Number.isFinite(location.lon)
    && location.lon >= -180 && location.lon <= 180;
}

function sameLocation(a, b) {
  return validLocation(a) && validLocation(b)
    && Math.abs(a.lat - b.lat) <= 0.01 && Math.abs(a.lon - b.lon) <= 0.01;
}

function validTimezone(value) {
  if (typeof value !== "string" || !value || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateForecastHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0 || hours.length > 3000) return false;
  let previous;
  for (const hour of hours) {
    if (!isObject(hour) || !Number.isSafeInteger(hour.t)
        || !Number.isFinite(new Date(hour.t * 1000).getTime())
        || !Number.isFinite(new Date((hour.t + HOUR) * 1000).getTime())
        || (previous !== undefined && (hour.t <= previous || (hour.t - previous) % HOUR !== 0))) return false;
    for (const [key, [min, max]] of Object.entries(OBSERVATIONS)) {
      if (!Object.hasOwn(hour, key)) return false;
      const value = hour[key];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) return false;
    }
    previous = hour.t;
  }
  return true;
}

function hasRemainingCoverage(hours, now) {
  return hours.some((hour) => hour.t + HOUR > now && hour.tempC !== null && hour.dewPointC !== null);
}

function matchingCheckedAt(data, checkStatus, now) {
  if (!isObject(checkStatus) || typeof data?.generatedAt !== "string"
      || checkStatus.generatedAt !== data.generatedAt) return null;
  const publishedAt = timestamp(data.generatedAt);
  const checkedAt = timestamp(checkStatus.checkedAt);
  if (publishedAt === null || checkedAt === null || checkedAt < publishedAt
      || checkedAt > now + FUTURE_SKEW) return null;
  return checkedAt;
}

export function checkerMetadata(data, checkStatus = null, now = Math.floor(Date.now() / 1000)) {
  if (!isObject(data) || !validLocation(data.location) || !validTimezone(data.timezone)) return null;
  const publishedAt = timestamp(data.generatedAt);
  if (publishedAt === null) return null;
  return {
    publishedAt,
    checkedAt: matchingCheckedAt(data, checkStatus, now),
    location: { lat: data.location.lat, lon: data.location.lon, label: typeof data.location.label === "string" ? data.location.label : "" },
    timezone: data.timezone,
    hasRawForecast: validateForecastHours(data.forecastHours),
  };
}

function candidate(data, source, settings, now, maxAgeSeconds, checkStatus = null) {
  if (!isObject(data)) throw new Error("Forecast response is not an object");
  const location = source === "live" ? settings.location : data.location ?? data.settings?.location;
  const hours = source === "background" ? data.forecastHours : data.hours;
  const checkedAt = source === "background" ? matchingCheckedAt(data, checkStatus, now) : null;
  const fetchedAt = checkedAt ?? timestamp(source === "background" ? data.generatedAt : data.fetchedAt);
  if (!sameLocation(location, settings.location)) throw new Error("Forecast location does not match current settings");
  if (!validTimezone(data.timezone)) throw new Error("Forecast timezone is invalid");
  if (fetchedAt === null || fetchedAt > now + FUTURE_SKEW || now - fetchedAt > maxAgeSeconds) {
    throw new Error("Forecast is too old or has an invalid fetch time");
  }
  if (!validateForecastHours(hours)) throw new Error("Forecast observations are malformed");
  if (!hasRemainingCoverage(hours, now)) {
    throw new Error("Forecast has no usable remaining coverage");
  }
  const plan = planForecast(hours, settings, now);
  return { source, location, timezone: data.timezone, hours, fetchedAt,
    generatedAt: source === "background" ? data.generatedAt : null,
    checkStatus: source === "background" ? checkStatus : null,
    coverageEnd: hours.at(-1).t + HOUR, plan };
}

const initialState = () => ({ phase: "unavailable", source: null, timezone: "UTC", evaluated: [], windows: [],
  status: null, fetchedAt: null, coverageEnd: null, checker: null, feedAvailable: false, error: null });

export function createForecastController({ fetchLive, fetchBackground, fetchCheckStatus = async () => null,
  checkFeed, readCache, writeCache,
  onState, now = () => Math.floor(Date.now() / 1000), maxAgeSeconds = MAX_FORECAST_AGE }) {
  let generation = 0;
  let state = initialState();
  let active = null;
  let checker = null;
  let checkerHours = null;
  let feedVerified = false;
  let feedAvailable = false;

  const currentFeedAvailability = (currentTime) => Boolean(feedVerified && checker?.hasRawForecast
    && (checker.checkedAt ?? checker.publishedAt) <= currentTime + FUTURE_SKEW
    && currentTime - (checker.checkedAt ?? checker.publishedAt) <= maxAgeSeconds
    && hasRemainingCoverage(checkerHours, currentTime));

  const publish = (next) => {
    state = next;
    onState(next);
  };
  const resultState = (record, warning = null) => ({
    phase: "ready", source: record.source, timezone: record.timezone,
    evaluated: record.plan.evaluated, windows: record.plan.windows, status: record.plan.status,
    fetchedAt: record.fetchedAt, coverageEnd: record.coverageEnd,
    checker, feedAvailable, error: warning,
  });
  const metadataState = (background, checkStatus, feed, currentTime) => {
    checker = checkerMetadata(background, checkStatus, currentTime);
    checkerHours = checker?.hasRawForecast ? background.forecastHours : null;
    feedVerified = Boolean(feed);
    feedAvailable = currentFeedAvailability(currentTime);
    publish({ ...state, checker, feedAvailable });
  };

  async function refresh(settingsInput) {
    const settings = mergeSettings(settingsInput);
    const id = ++generation;
    active = null;
    checker = null;
    checkerHours = null;
    feedVerified = false;
    feedAvailable = false;
    publish({ ...initialState(), phase: "loading" });

    // Metadata is consulted even after a successful live fetch. These reads
    // cannot update the view unless this generation still owns the request.
    const backgroundPromise = Promise.resolve().then(fetchBackground).catch(() => null);
    const checkStatusPromise = Promise.resolve().then(fetchCheckStatus).catch(() => null);
    const feedPromise = Promise.resolve().then(checkFeed).catch(() => false);
    let liveError;
    try {
      const live = await fetchLive(settings);
      if (id !== generation) return;
      const record = candidate(live, "live", settings, now(), maxAgeSeconds);
      active = { record, settings };
      publish(resultState(record));
      try {
        writeCache({ location: record.location, timezone: record.timezone,
          hours: record.hours, fetchedAt: record.fetchedAt });
      } catch {
        // Disabled or full browser storage must not hide a valid live forecast.
      }
    } catch (error) {
      if (id !== generation) return;
      liveError = error;
      const [background, checkStatus] = await Promise.all([backgroundPromise, checkStatusPromise]);
      if (id !== generation) return;
      let record;
      try {
        record = candidate(background, "background", settings, now(), maxAgeSeconds, checkStatus);
      } catch {
        try {
          record = candidate(readCache(), "cache", settings, now(), maxAgeSeconds);
        } catch {
          // Neither fallback has a valid forecast for this location and time.
        }
      }
      if (record) {
        active = { record, settings };
        publish(resultState(record, liveError?.message || String(liveError)));
      } else {
        publish({ ...initialState(), phase: "unavailable", error: liveError?.message || String(liveError) });
      }
    }

    const [background, checkStatus, feed] = await Promise.all([backgroundPromise, checkStatusPromise, feedPromise]);
    if (id === generation) metadataState(background, checkStatus, feed, now());
  }

  function tick() {
    const currentTime = now();
    feedAvailable = currentFeedAvailability(currentTime);
    if (!active) {
      if (feedAvailable !== state.feedAvailable) publish({ ...state, feedAvailable });
      return;
    }
    const { record, settings } = active;
    try {
      const updated = candidate({ location: record.location, timezone: record.timezone,
        hours: record.hours, fetchedAt: record.fetchedAt,
        generatedAt: record.generatedAt ?? new Date(record.fetchedAt * 1000).toISOString(),
        forecastHours: record.hours }, record.source, settings, currentTime, maxAgeSeconds, record.checkStatus);
      active = { record: updated, settings };
      publish(resultState(updated, state.error));
    } catch {
      active = null;
      publish({ ...initialState(), checker, feedAvailable, error: "Forecast data has expired. Refresh to try again." });
    }
  }

  function invalidate() {
    generation++;
    active = null;
    checker = null;
    checkerHours = null;
    feedVerified = false;
    feedAvailable = false;
    state = initialState();
  }

  return { refresh, tick, invalidate, getState: () => state };
}
