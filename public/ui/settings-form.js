// DOM-free conversion between the settings form and Celsius-based settings.
import { cToF, fToC } from "../core/psychro.js";

const TEMPERATURE_FIELDS = [
  "indoor-temp", "coldest-surface", "min-outdoor", "max-outdoor", "indoor-reading-temp",
];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isUnit(value) {
  return value === "C" || value === "F";
}

function isBlank(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function numberFromField(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

// Keep useful input precision without exposing binary floating-point noise.
function rounded(value) {
  const precise = Number(value.toFixed(10));
  // A round trip through a repeating decimal can leave a tiny tail, e.g.
  // 86.75°F → 30.4166666667°C → 86.7500000001°F. Remove only such tails.
  for (let decimals = 0; decimals <= 6; decimals++) {
    const shorter = Number(precise.toFixed(decimals));
    if (Math.abs(shorter - precise) < 1e-9) return shorter;
  }
  return precise;
}

function numberToField(value) {
  return Number.isFinite(value) ? String(rounded(value)) : "";
}

/** Fill every form field, including hidden readings that a reset must clear. */
export function settingsToFields(settings) {
  const s = record(settings);
  const location = record(s.location);
  const reading = record(s.indoorReading);
  const unit = isUnit(s.units) ? s.units : "";
  const temperature = (value) => Number.isFinite(value)
    ? numberToField(unit === "F" ? cToF(value) : value)
    : "";
  return {
    lat: numberToField(location.lat),
    lon: numberToField(location.lon),
    label: typeof location.label === "string" ? location.label : "",
    units: unit,
    "indoor-temp": temperature(s.indoorTempC),
    "target-rh": numberToField(s.targetRH),
    "coldest-surface": temperature(s.coldestSurfaceC),
    margin: numberToField(s.marginC),
    "min-outdoor": temperature(s.minOutdoorC),
    "max-outdoor": temperature(s.maxOutdoorC),
    "max-rain": numberToField(s.maxRainProb),
    "max-wind": numberToField(s.maxWindKmh),
    "min-window-hours": numberToField(s.minWindowHours),
    "forecast-days": numberToField(s.forecastDays),
    "require-drying": s.requireDrying === true,
    "indoor-reading-temp": temperature(reading.tempC),
    "indoor-reading-rh": numberToField(reading.rh),
  };
}

/** Read only the settings exposed by the form; callers own merging/validation. */
export function fieldsToSettings(fields) {
  const f = record(fields);
  const unit = isUnit(f.units) ? f.units : "";
  const temperature = (value) => {
    const number = numberFromField(value);
    return unit === "F" ? rounded(fToC(number)) : number;
  };
  const requireDrying = f["require-drying"] === true;
  const hasReading = !isBlank(f["indoor-reading-temp"]) || !isBlank(f["indoor-reading-rh"]);
  return {
    location: {
      lat: numberFromField(f.lat),
      lon: numberFromField(f.lon),
      label: typeof f.label === "string" ? f.label.trim() : "",
    },
    units: unit,
    indoorTempC: temperature(f["indoor-temp"]),
    targetRH: numberFromField(f["target-rh"]),
    coldestSurfaceC: isBlank(f["coldest-surface"]) ? null : temperature(f["coldest-surface"]),
    marginC: numberFromField(f.margin),
    minOutdoorC: temperature(f["min-outdoor"]),
    maxOutdoorC: temperature(f["max-outdoor"]),
    maxRainProb: numberFromField(f["max-rain"]),
    maxWindKmh: numberFromField(f["max-wind"]),
    minWindowHours: numberFromField(f["min-window-hours"]),
    forecastDays: numberFromField(f["forecast-days"]),
    requireDrying,
    indoorReading: requireDrying && hasReading ? {
      tempC: temperature(f["indoor-reading-temp"]),
      rh: numberFromField(f["indoor-reading-rh"]),
    } : null,
  };
}

/** Convert the current draft, preserving unrelated edits and invalid text. */
export function convertTemperatureFields(fields, fromUnit, toUnit) {
  const converted = { ...record(fields) };
  if (!isUnit(fromUnit) || !isUnit(toUnit)) return converted;
  converted.units = toUnit;
  if (fromUnit === toUnit) return converted;
  const convert = toUnit === "F" ? cToF : fToC;
  for (const key of TEMPERATURE_FIELDS) {
    const value = numberFromField(converted[key]);
    const temperature = convert(value);
    if (Number.isFinite(value) && Number.isFinite(temperature)) converted[key] = numberToField(temperature);
  }
  return converted;
}
