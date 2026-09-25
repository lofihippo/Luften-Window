// Dependency-free, timestamp-based chart. The native slider and table expose
// the same observations as the pointer chart without requiring SVG navigation.
import { cToF } from "../core/psychro.js";
import { computeLimitC } from "../core/windows.js";
import { forecastDateKey } from "./forecast-time.js";

const HOUR = 3600;
const SVG_NS = "http://www.w3.org/2000/svg";
const REASONS = {
  DEW_TOO_HIGH: "Dew point above the limit", TOO_COLD: "Outdoor air too cold",
  TOO_HOT: "Outdoor air too warm", RAIN_LIKELY: "Rain likely", RAINING: "Rain forecast",
  TOO_WINDY: "Wind too strong", NO_DATA: "Required forecast data missing",
  WINDOW_TOO_SHORT: "Dry period shorter than the minimum window",
};
let nextChartId = 0;

export function chartDomain(values, { percentage = false } = {}) {
  const valid = values.filter(Number.isFinite);
  let low = valid.length ? Math.min(...valid) : 0;
  let high = valid.length ? Math.max(...valid) : (percentage ? 100 : 20);
  const padding = Math.max((high - low) * 0.12, percentage ? 2 : 1);
  low -= padding;
  high += padding;
  const rough = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((value) => value * power >= rough) * power;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  if (percentage) { low = Math.max(0, low); high = Math.min(100, high); }
  if (high <= low) high = low + 1;
  const ticks = [];
  for (let value = low; value <= high + step / 100; value += step) ticks.push(Number(value.toFixed(6)));
  if (ticks.at(-1) !== high) ticks.push(high);
  return { min: low, max: high, ticks };
}

export function closestHourIndex(hours, timestamp) {
  if (!hours.length) return -1;
  let best = 0;
  for (let index = 1; index < hours.length; index++) {
    if (Math.abs(hours[index].t - timestamp) < Math.abs(hours[best].t - timestamp)) best = index;
  }
  return best;
}

export function seriesSegments(hours, valueOf) {
  const segments = [];
  let current = [];
  let previousTime;
  for (const hour of hours) {
    const value = valueOf(hour);
    if (!Number.isFinite(value) || (previousTime !== undefined && hour.t !== previousTime + HOUR)) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (Number.isFinite(value)) current.push({ t: hour.t, value });
    previousTime = hour.t;
  }
  if (current.length) segments.push(current);
  return segments;
}

export function chartHourOutcome(hour, windows) {
  if (windows.some((window) => hour.t >= window.start && hour.t < window.end)) return "Suitable opening window";
  if (hour.ok) return REASONS.WINDOW_TOO_SHORT;
  return (hour.reasons?.length ? hour.reasons : ["NO_DATA"]).map((reason) => REASONS[reason] || reason).join("; ");
}

export function createChartModel({ hours = [], windows = [], settings, now, viewHours = 24, selectedTime }) {
  const available = hours.filter((hour) => Number.isFinite(hour.t) && hour.t + HOUR > now);
  if (!available.length) return null;
  const duration = [24, 48, 72].includes(viewHours) ? viewHours : 24;
  const start = Math.min(available[0].t, Math.floor(now / HOUR) * HOUR);
  const end = start + duration * HOUR;
  const visible = available.filter((hour) => hour.t >= start && hour.t < end);
  const toDisplay = (value) => Number.isFinite(value) ? (settings.units === "F" ? cToF(value) : value) : null;
  const limitC = visible.find((hour) => Number.isFinite(hour.limitC))?.limitC ?? computeLimitC(settings);
  const limit = toDisplay(limitC);
  const dew = chartDomain([...visible.map((hour) => toDisplay(hour.dewPointC)), limit]);
  const rh = chartDomain([...visible.map((hour) => hour.predictedIndoorRH), settings.targetRH], { percentage: true });
  const width = Math.max(640, duration * 20 + 128);
  const left = 62, right = width - 62, top = 48, bottom = 240;
  const x = (time) => left + (time - start) / (end - start) * (right - left);
  const y = (value, domain) => bottom - (value - domain.min) / (domain.max - domain.min) * (bottom - top);
  return {
    hours: visible, start, end, width, height: 302, left, right, top, bottom, x,
    yDew: (value) => y(value, dew), yRH: (value) => y(value, rh), dew, rh, limit, limitC, toDisplay,
    bands: windows.filter((window) => window.end > start && window.start < end)
      .map((window) => ({ start: Math.max(start, window.start), end: Math.min(end, window.end) })),
    selectedIndex: Number.isFinite(selectedTime)
      ? closestHourIndex(visible, selectedTime)
      : visible.length ? Math.max(0, visible.findIndex((hour) => hour.t <= now && now < hour.t + HOUR)) : -1,
  };
}

export function createForecastChart(root) {
  const document = root.ownerDocument;
  const id = `forecast-chart-${++nextChartId}`;
  let input, model, viewHours = 24, selectedTime, dismissed = false, detailSignature = "";
  let selectionLine, selectionDew, selectionRH;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgElement = (tag, attrs = {}, text) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, onClick) => {
    const node = element("button", "fc-button", text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };
  root.classList.add("forecast-chart");
  const content = element("div", "fc-content");
  const empty = element("p", "fc-empty", "Forecast timeline will appear when data is available.");
  const toolbar = element("div", "fc-toolbar");
  const views = element("div", "fc-views");
  views.setAttribute("role", "group"); views.setAttribute("aria-label", "Forecast timespan");
  const viewButtons = [24, 48, 72].map((hours) => {
    const node = button(`${hours}h`, () => { viewHours = hours; dismissed = false; render(); });
    node.setAttribute("aria-label", `${hours}h forecast`);
    views.append(node); return node;
  });
  const timezoneLabel = element("span", "fc-timezone");
  toolbar.append(views, timezoneLabel);
  const legend = element("ul", "fc-legend");
  for (const [style, label] of [["dew", "Outdoor dew point"], ["rh", "RH at indoor temperature"], ["window", "Opening window"]]) {
    const item = element("li");
    const swatch = element("span", `fc-swatch fc-swatch-${style}`); swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, document.createTextNode(label)); legend.append(item);
  }
  const references = element("p", "fc-references");
  const estimateNote = element("p", "fc-hint");
  const viewport = element("div", "fc-viewport");
  viewport.tabIndex = 0; viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "Scrollable forecast chart");
  const hint = element("p", "fc-hint", "Scroll the chart to see later hours. Tap the chart or use the hour controls below for details. Gaps mean no observation is available.");
  hint.id = `${id}-hint`; viewport.setAttribute("aria-describedby", hint.id);
  const inspector = element("div", "fc-inspector");
  const label = element("label", "fc-slider-label", "Inspect forecast hour");
  const slider = element("input", "fc-slider");
  slider.type = "range"; slider.min = "0"; slider.step = "1"; slider.id = `${id}-hour`;
  label.htmlFor = slider.id;
  const help = element("p", "fc-hint", "Use arrow keys to move between hours, Home / End for the first / last hour, or Escape to hide details.");
  help.id = `${id}-keys`; slider.setAttribute("aria-describedby", help.id);
  const navigation = element("div", "fc-navigation");
  const previous = button("← Previous hour", () => select(model.selectedIndex - 1, true));
  const next = button("Next hour →", () => select(model.selectedIndex + 1, true));
  navigation.append(previous, next);
  const detail = element("section", "fc-detail");
  detail.id = `${id}-details`;
  detail.setAttribute("aria-live", "polite"); detail.setAttribute("aria-atomic", "true");
  slider.setAttribute("aria-controls", detail.id);
  const dismissedNote = element("p", "fc-hint", "Hour details hidden. Choose an hour to show them again.");
  dismissedNote.hidden = true;
  inspector.append(label, slider, navigation, help, detail, dismissedNote);
  const alternative = element("details", "fc-alternative");
  const summary = element("summary", "", "View hourly data table");
  const tableViewport = element("div", "fc-table-viewport");
  tableViewport.tabIndex = 0; tableViewport.setAttribute("role", "region");
  tableViewport.setAttribute("aria-label", "Scrollable hourly forecast table");
  alternative.append(summary, tableViewport);
  content.append(toolbar, legend, references, estimateNote, viewport, hint, inspector, alternative);
  root.replaceChildren(empty, content); content.hidden = true;

  const formatTime = (time, options) => new Intl.DateTimeFormat(undefined, { timeZone: input.timezone, ...options }).format(new Date(time * 1000));
  const fullTime = (time) => formatTime(time, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const temp = (value) => Number.isFinite(value) ? `${Math.round(model.toDisplay(value) * 10) / 10}°${input.settings.units === "F" ? "F" : "C"}` : "Unavailable";
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value)}%` : "Unavailable";
  const values = (hour) => [temp(hour.tempC), temp(hour.dewPointC), percent(hour.rh), percent(hour.precipProb), percent(hour.predictedIndoorRH)];
  const labels = ["Outdoor temperature", "Outdoor dew point", "Outdoor RH", "Rain chance", "RH at indoor temperature"];

  function select(index, reveal = false) {
    if (!model?.hours.length) return;
    model.selectedIndex = Math.max(0, Math.min(model.hours.length - 1, index));
    const hour = model.hours[model.selectedIndex];
    selectedTime = hour.t; dismissed = false;
    renderSelection();
    if (reveal) {
      const position = model.x(hour.t);
      if (position < viewport.scrollLeft + 40 || position > viewport.scrollLeft + viewport.clientWidth - 40) {
        viewport.scrollLeft = Math.max(0, position - viewport.clientWidth / 2);
      }
    }
  }

  function renderSelection() {
    if (!model?.hours.length) return;
    const hour = model.hours[model.selectedIndex];
    slider.value = String(model.selectedIndex);
    const outcome = chartHourOutcome(hour, input.windows || []);
    const displayValues = values(hour);
    slider.setAttribute("aria-valuetext", `${fullTime(hour.t)}. Outdoor dew point ${displayValues[1]}; outdoor-air RH at ${temp(input.settings.indoorTempC)}: ${displayValues[4]}. ${outcome}`);
    previous.disabled = model.selectedIndex === 0; next.disabled = model.selectedIndex === model.hours.length - 1;
    detail.hidden = dismissed; dismissedNote.hidden = !dismissed;
    const signature = JSON.stringify([fullTime(hour.t), displayValues, outcome]);
    if (signature !== detailSignature) {
      const title = element("h3", "fc-detail-title", fullTime(hour.t));
      const status = element("p", "fc-detail-status", outcome);
      const list = element("dl", "fc-metrics");
      labels.forEach((label, index) => {
        const pair = element("div"); pair.append(element("dt", "", label), element("dd", "", displayValues[index])); list.append(pair);
      });
      detail.replaceChildren(title, status, list); detailSignature = signature;
    }
    const x = model.x(hour.t);
    selectionLine.setAttribute("x1", x); selectionLine.setAttribute("x2", x);
    selectionLine.setAttribute("visibility", dismissed ? "hidden" : "visible");
    for (const [node, value, y] of [[selectionDew, model.toDisplay(hour.dewPointC), model.yDew], [selectionRH, hour.predictedIndoorRH, model.yRH]]) {
      node.setAttribute("visibility", dismissed || !Number.isFinite(value) ? "hidden" : "visible");
      if (Number.isFinite(value)) { node.setAttribute("cx", x); node.setAttribute("cy", y(value)); }
    }
  }

  function render() {
    if (!input) return;
    model = createChartModel({ ...input, viewHours, selectedTime });
    if (!model) { clear("No forecast hours are available in this view."); return; }
    content.hidden = false;
    viewButtons.forEach((node, index) => node.setAttribute("aria-pressed", String([24, 48, 72][index] === viewHours)));
    timezoneLabel.textContent = `Times in ${input.timezone}`;
    const hasHours = model.hours.length > 0;
    for (const node of [legend, references, estimateNote, viewport, hint, inspector, alternative]) node.hidden = !hasHours;
    empty.hidden = hasHours;
    if (!hasHours) {
      empty.textContent = `No forecast hours are available in this ${viewHours}-hour view. Choose another timespan to check later coverage.`;
      return;
    }
    selectedTime = model.hours[model.selectedIndex].t;
    references.textContent = `Dashed lines: dew limit ${temp(model.limitC)}; RH target ${percent(input.settings.targetRH)}.`;
    estimateNote.textContent = `RH estimates outdoor air at ${temp(input.settings.indoorTempC)}, not measured room humidity.`;
    slider.max = String(model.hours.length - 1);
    const { width, height, left, right, top, bottom, x } = model;
    const svg = svgElement("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${viewHours}-hour forecast. Outdoor dew point uses the left temperature axis; outdoor-air RH at indoor temperature uses the right percentage axis. Striped bands are suitable opening windows. Use the hour controls or data table for values.`, class: "fc-svg" });
    const defs = svgElement("defs");
    const pattern = svgElement("pattern", { id: `${id}-window`, width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    pattern.append(svgElement("rect", { width: 8, height: 8, fill: "var(--good-soft)" }), svgElement("line", { x1: 0, y1: 0, x2: 0, y2: 8, stroke: "var(--good)", "stroke-opacity": 0.32, "stroke-width": 2 }));
    defs.append(pattern); svg.append(defs);
    for (const band of model.bands) svg.append(svgElement("rect", { x: x(band.start), y: top, width: x(band.end) - x(band.start), height: bottom - top, fill: `url(#${id}-window)` }));
    for (const tick of model.dew.ticks) {
      const y = model.yDew(tick);
      svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: "fc-grid" }), svgElement("text", { x: left - 9, y: y + 4, "text-anchor": "end", class: "fc-axis" }, `${tick}°`));
    }
    for (const tick of model.rh.ticks) svg.append(svgElement("text", { x: right + 9, y: model.yRH(tick) + 4, class: "fc-axis" }, `${tick}%`));
    svg.append(svgElement("text", { x: left, y: 20, class: "fc-axis-title" }, `Dew point (°${input.settings.units === "F" ? "F" : "C"})`), svgElement("text", { x: right, y: 20, "text-anchor": "end", class: "fc-axis-title" }, "RH at indoor temperature (%)"));
    let previousDay = forecastDateKey(model.start, input.timezone);
    for (let time = model.start; time <= model.end; time += HOUR) {
      const day = forecastDateKey(time, input.timezone);
      if (day !== previousDay) svg.append(svgElement("line", { x1: x(time), x2: x(time), y1: top, y2: bottom, class: "fc-day-line" }));
      previousDay = day;
      if ((time - model.start) % (6 * HOUR) === 0) {
        const attrs = { x: x(time), "text-anchor": "middle", class: "fc-axis" };
        svg.append(svgElement("text", { ...attrs, y: bottom + 24 }, formatTime(time, { hour: "numeric", minute: "2-digit" })), svgElement("text", { ...attrs, y: bottom + 43 }, formatTime(time, { month: "short", day: "numeric" })));
      }
    }
    const plotSeries = (segments, scale, className) => {
      for (const segment of segments) {
        svg.append(segment.length === 1
          ? svgElement("circle", { cx: x(segment[0].t), cy: scale(segment[0].value), r: 3, class: className })
          : svgElement("polyline", { points: segment.map((point) => `${x(point.t)},${scale(point.value)}`).join(" "), class: className }));
      }
    };
    plotSeries(seriesSegments(model.hours, (hour) => model.toDisplay(hour.dewPointC)), model.yDew, "fc-series-dew");
    plotSeries(seriesSegments(model.hours, (hour) => hour.predictedIndoorRH), model.yRH, "fc-series-rh");
    for (const [value, scale, kind, label] of [[model.limit, model.yDew, "dew", `Dew limit ${temp(model.limitC)}`], [input.settings.targetRH, model.yRH, "rh", `RH target ${percent(input.settings.targetRH)}`]]) {
      if (!Number.isFinite(value)) continue;
      const y = scale(value);
      svg.append(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: `fc-reference-${kind}` }), svgElement("text", { x: kind === "dew" ? left + 6 : right - 6, y: Math.max(top + 13, y - 7), "text-anchor": kind === "dew" ? "start" : "end", class: "fc-reference-label" }, label));
    }
    if (input.now >= model.start && input.now <= model.end) {
      svg.append(svgElement("line", { x1: x(input.now), x2: x(input.now), y1: top - 8, y2: bottom, class: "fc-now" }), svgElement("text", { x: x(input.now) + 5, y: top - 15, class: "fc-axis-title" }, "Now"));
    }
    selectionLine = svgElement("line", { y1: top, y2: bottom, class: "fc-selection" });
    selectionDew = svgElement("circle", { r: 5, class: "fc-selected-dew" });
    selectionRH = svgElement("circle", { r: 5, class: "fc-selected-rh" });
    svg.append(selectionLine, selectionDew, selectionRH);
    svg.addEventListener("click", (event) => {
      const rect = svg.getBoundingClientRect();
      const position = (event.clientX - rect.left) * width / rect.width;
      const timestamp = model.start + (position - left) / (right - left) * (model.end - model.start);
      select(closestHourIndex(model.hours, timestamp));
    });
    const oldScroll = viewport.scrollLeft;
    viewport.replaceChildren(svg); viewport.scrollLeft = oldScroll;
    renderSelection();
    const table = element("table", "fc-table");
    const caption = element("caption", "", `${viewHours}-hour forecast in ${input.timezone}. RH at indoor temperature estimates outdoor-air humidity at ${temp(input.settings.indoorTempC)}, not your room's measured humidity.`);
    const head = element("thead"), header = element("tr"), body = element("tbody");
    for (const title of ["Local time", ...labels, "Assessment"]) { const th = element("th", "", title); th.scope = "col"; header.append(th); }
    head.append(header);
    for (const hour of model.hours) {
      const row = element("tr"), stamp = element("th", "", fullTime(hour.t)); stamp.scope = "row"; row.append(stamp);
      for (const value of [...values(hour), chartHourOutcome(hour, input.windows || [])]) row.append(element("td", "", value));
      body.append(row);
    }
    table.append(caption, head, body); tableViewport.replaceChildren(table);
  }

  function clear(message = "Forecast timeline is unavailable.") {
    content.hidden = true; empty.hidden = false; empty.textContent = message;
  }
  slider.addEventListener("input", () => select(Number(slider.value), true));
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && model?.hours.length) { dismissed = true; renderSelection(); event.stopPropagation(); }
  });
  return {
    update(value) { input = value; render(); },
    clear,
  };
}
