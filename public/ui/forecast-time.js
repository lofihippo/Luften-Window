// Calendar boundaries must follow the forecast location, not the device clock.
const dateFormatters = new Map();
const hourFormatters = new Map();

function formatter(cache, timeZone, options) {
  if (!cache.has(timeZone)) {
    cache.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, ...options }));
  }
  return cache.get(timeZone);
}

export function forecastDateKey(epoch, timeZone) {
  const parts = formatter(dateFormatters, timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(epoch * 1000));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function forecastHour(epoch, timeZone) {
  const parts = formatter(hourFormatters, timeZone, {
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1000));
  return Number(parts.find((item) => item.type === "hour").value);
}

export function formatForecastRange(start, end, timeZone, locale) {
  const day = new Intl.DateTimeFormat(locale, {
    timeZone, weekday: "short", month: "short", day: "numeric",
  });
  const hour = new Intl.DateTimeFormat(locale, {
    timeZone, hour: "numeric", minute: "2-digit",
  });
  const at = (epoch) => new Date(epoch * 1000);
  const sameDay = forecastDateKey(start, timeZone) === forecastDateKey(end, timeZone);
  return sameDay
    ? `${day.format(at(start))} ${hour.format(at(start))} – ${hour.format(at(end))}`
    : `${day.format(at(start))} ${hour.format(at(start))} – ${day.format(at(end))} ${hour.format(at(end))}`;
}
