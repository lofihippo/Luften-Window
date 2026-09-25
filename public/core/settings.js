// Settings defaults merge, validation, and URL (de)serialization.
// Shared by browser and Node.

// Existing short keys remain compatible with older share links.
const QUERY_KEYS = {
  indoorTempC: "it",
  targetRH: "rh",
  coldestSurfaceC: "cs",
  marginC: "m",
  minOutdoorC: "mn",
  maxOutdoorC: "mx",
  maxRainProb: "rp",
  maxWindKmh: "w",
  minWindowHours: "mw",
  forecastDays: "fd",
};

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return deepMerge({}, value);
  return value;
}

/** Deep merge defaults < overrides. Ignore corrupt root overrides and absent values. */
export function mergeSettings(defaults, ...overrides) {
  let out = clone(defaults);
  for (const override of overrides) {
    if (isPlainObject(override)) out = deepMerge(out, override);
  }
  return out;
}

function deepMerge(base, override) {
  const result = {};
  if (isPlainObject(base)) {
    for (const [key, value] of Object.entries(base)) {
      if (!UNSAFE_KEYS.has(key)) result[key] = clone(value);
    }
  }
  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : clone(value);
  }
  return result;
}

/** Validate untrusted settings. fieldErrors maps settings paths to readable errors. */
export function validate(settings) {
  const errors = [];
  const fieldErrors = {};
  const error = (path, message) => {
    errors.push(message);
    fieldErrors[path] = message;
  };
  const result = () => ({ ok: errors.length === 0, errors, fieldErrors });
  const number = (path, value, min = -Infinity, max = Infinity, integer = false) => {
    if (typeof value !== "number" || !Number.isFinite(value)
        || value < min || value > max || (integer && !Number.isInteger(value))) {
      const range = Number.isFinite(min) && Number.isFinite(max)
        ? `between ${min} and ${max}`
        : `>= ${min}`;
      error(path, `${path} must be a finite ${integer ? "integer" : "number"} ${range}`);
    }
  };
  const boolean = (path, value) => {
    if (typeof value !== "boolean") error(path, `${path} must be true or false`);
  };

  if (!isPlainObject(settings)) {
    error("settings", "Settings must be an object");
    return result();
  }
  if (!isPlainObject(settings.location)) {
    error("location", "location must contain latitude and longitude");
  } else {
    number("location.lat", settings.location.lat, -90, 90);
    number("location.lon", settings.location.lon, -180, 180);
    if (settings.location.label !== undefined && typeof settings.location.label !== "string") {
      error("location.label", "location.label must be text");
    }
  }
  if (settings.units !== "C" && settings.units !== "F") error("units", "units must be C or F");

  // Broad physical input bounds, in Celsius regardless of display units.
  for (const key of ["indoorTempC", "minOutdoorC", "maxOutdoorC"]) {
    number(key, settings[key], -100, 100);
  }
  if (settings.coldestSurfaceC != null) number("coldestSurfaceC", settings.coldestSurfaceC, -100, 100);
  number("targetRH", settings.targetRH, 20, 80);
  number("marginC", settings.marginC, 0);
  if (!fieldErrors.minOutdoorC && !fieldErrors.maxOutdoorC && settings.minOutdoorC >= settings.maxOutdoorC) {
    error("minOutdoorC", "minOutdoorC must be < maxOutdoorC");
  }
  number("maxRainProb", settings.maxRainProb, 0, 100);
  number("maxWindKmh", settings.maxWindKmh, 0);
  number("minWindowHours", settings.minWindowHours, 1, Infinity, true);
  number("forecastDays", settings.forecastDays, 1, 16, true);
  boolean("requireDrying", settings.requireDrying);

  // A missing reading is allowed even when drying is requested (SPEC Section 2).
  if (settings.indoorReading != null) {
    if (!isPlainObject(settings.indoorReading)) {
      error("indoorReading", "indoorReading must be null or contain temperature and humidity");
    } else {
      number("indoorReading.tempC", settings.indoorReading.tempC, -100, 100);
      const rh = settings.indoorReading.rh;
      if (typeof rh !== "number" || !Number.isFinite(rh) || rh <= 0 || rh > 100) {
        error("indoorReading.rh", "indoorReading.rh must be a finite number greater than 0 and at most 100");
      }
    }
  }

  // Older configs may omit notify, realtime, or digest. Validate supplied blocks.
  if (settings.notify !== undefined) {
    if (!isPlainObject(settings.notify)) {
      error("notify", "notify must be an object");
    } else {
      boolean("notify.enabled", settings.notify.enabled);
      number("notify.leadHours", settings.notify.leadHours, 0);
      if (settings.notify.realtime !== undefined) boolean("notify.realtime", settings.notify.realtime);
      if (settings.notify.digest !== undefined) {
        if (!isPlainObject(settings.notify.digest)) {
          error("notify.digest", "notify.digest must be an object");
        } else {
          boolean("notify.digest.enabled", settings.notify.digest.enabled);
          number("notify.digest.hourLocal", settings.notify.digest.hourLocal, 0, 23, true);
        }
      }
    }
  }
  return result();
}

/** Serialize recommendation settings, including false and explicit optional clears. */
export function toQuery(settings) {
  const params = new URLSearchParams();
  const put = (key, value) => {
    if (value !== undefined) params.set(key, String(value));
  };
  put("lat", settings.location?.lat);
  put("lon", settings.location?.lon);
  // An absent label must clear a recipient's existing label too.
  put("label", settings.location?.label ?? "");
  for (const [field, key] of Object.entries(QUERY_KEYS)) {
    put(key, field === "coldestSurfaceC" ? settings[field] ?? null : settings[field]);
  }
  put("u", settings.units);
  put("rd", settings.requireDrying);
  if (settings.indoorReading == null) {
    put("ir", null);
  } else {
    put("irt", settings.indoorReading.tempC);
    put("irr", settings.indoorReading.rh);
  }
  return params.toString();
}

/** Parse only present URL keys. Invalid values remain invalid until validation. */
export function fromQuery(searchParams) {
  const has = (key) => searchParams.has(key);
  const get = (key) => searchParams.get(key);
  const numeric = (key) => {
    const value = get(key);
    // Number("") and Number(null) are zero, so reject missing/blank inputs first.
    if (value === null || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return NaN;
    return Number(value);
  };
  const out = {};
  if (has("lat") || has("lon") || has("label")) {
    out.location = {};
    if (has("lat")) out.location.lat = numeric("lat");
    if (has("lon")) out.location.lon = numeric("lon");
    if (has("label")) out.location.label = get("label");
  }
  for (const [field, key] of Object.entries(QUERY_KEYS)) {
    if (has(key)) out[field] = field === "coldestSurfaceC" && get(key) === "null" ? null : numeric(key);
  }
  if (has("u")) out.units = get("u");
  if (has("rd")) {
    const value = get("rd");
    out.requireDrying = value === "true" ? true : value === "false" ? false : value;
  }
  if (has("irt") || has("irr")) {
    // Readings are atomic: a partial URL must not borrow the other stored value.
    // A simultaneous ir marker is ambiguous and therefore invalid.
    out.indoorReading = {
      tempC: has("ir") ? NaN : numeric("irt"),
      rh: has("ir") ? NaN : numeric("irr"),
    };
  } else if (has("ir")) {
    out.indoorReading = get("ir") === "null" ? null : get("ir");
  }
  return out;
}
