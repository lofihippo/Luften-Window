// Psychrometric helpers. Pure functions, shared by browser and Node.
// All temperatures are Celsius internally unless a cToF/fToC is used.

const A = 17.625;
const B = 243.04;

/** κ (gamma) in the Magnus formula. */
function gamma(tempC, rh) {
  // rh is a percentage (0-100).
  return Math.log(rh / 100) + (A * tempC) / (B + tempC);
}

/** Dew point (Td) in °C from a temperature and relative humidity (%). */
export function dewPoint(tempC, rh) {
  const g = gamma(tempC, rh);
  return (B * g) / (A - g);
}

/**
 * Relative humidity (%) from a temperature (°C) and dew point (°C),
 * clamped to [0, 100].
 */
export function rhFrom(tempC, dewPointC) {
  const raw = 100 * Math.exp((A * dewPointC) / (B + dewPointC) - (A * tempC) / (B + tempC));
  return Math.max(0, Math.min(100, raw));
}

/** Celsius to Fahrenheit. */
export function cToF(c) {
  return (c * 9) / 5 + 32;
}

/** Fahrenheit to Celsius. */
export function fToC(f) {
  return ((f - 32) * 5) / 9;
}

/** Convert a Celsius delta to a Fahrenheit delta (no offset). */
export function deltaCtoF(dc) {
  return (dc * 9) / 5;
}
