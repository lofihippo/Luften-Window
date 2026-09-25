# Design and architecture

Luften-Window turns a regional weather forecast into useful opening and closing times. The current decision and next opportunity come first; the chart and advanced settings explain the recommendation when more detail is needed.

## Recommendation rule

Outdoor relative humidity alone cannot tell you how damp that air will be indoors: relative humidity changes with temperature. The planner uses outdoor dew point to estimate the relative humidity that air would have at the chosen indoor temperature. This assumes the air's moisture content stays the same as it warms or cools; it does not model a room, its ventilation rate or indoor moisture sources.

Calculations use Celsius and the Magnus approximation, with `a = 17.625` and `b = 243.04`:

```text
gamma(T, RH) = ln(RH / 100) + a * T / (b + T)
dewPoint(T, RH) = b * gamma / (a - gamma)
rhFrom(T, Td) = 100 * exp(a * Td / (b + Td) - a * T / (b + T))
```

Estimated relative humidity is clamped to 0–100%. The maximum allowed outdoor dew point is the lowest of:

- The dew point at the selected indoor temperature and target humidity.
- The optional coldest indoor surface temperature.
- The dew point of an optional indoor reading, when drying is required.

The safety margin is subtracted from that limit. Each hour must also satisfy outdoor temperature, rain and wind limits. Missing temperature or dew point prevents a recommendation; a missing dew point can be calculated from temperature and humidity. Missing optional rain/wind observations do not independently disqualify the hour. Malformed present observations reject the forecast.

A timestamp starts a one-hour interval. Consecutive suitable hours form a window; gaps split windows. The minimum duration applies to the full run, including available preceding hours, before completed hours are removed from display. An ongoing window therefore stays open through its final hour. A short suitable run, missing current data and unsuitable current weather have different status messages.

## Modules and data flow

| Area | Responsibility |
| --- | --- |
| `public/core/psychro.js` | Dew point, humidity and unit conversions |
| `public/core/settings.js` | Settings merge, validation and share-link encoding |
| `public/core/forecast.js` | Weather request, deadline and response normalization |
| `public/core/windows.js` | Shared hourly evaluation, grouping and current status |
| `public/core/zoned-time.js` | Calendar-day boundaries in the forecast timezone |
| `public/core/calendar.js` | Escaped, folded UTC calendar events and stable window IDs |
| `public/ui/` | Settings fields, storage, forecast state, date formatting and chart |
| `public/app.js` | DOM integration and interaction |
| `scripts/check.mjs` | Background forecast, public calendar and notifications |
| `scripts/delivery-state.mjs` and `scripts/notify.mjs` | Delivery confirmations and channel transports |
| `scripts/publication.mjs` | Staged file publication with rollback |
| `scripts/actions-state.mjs` | Workflow state selection, revision and publication checks |

Core modules have no DOM or Node dependencies. Both the browser and checker call the same planning logic. The site is plain HTML, CSS and JavaScript modules with no package dependencies or build step. Any static host can serve `public/`, including at a repository subpath. Node 22+ is needed only for development, tests and the optional checker.

### Settings

Precedence is deployment defaults, then browser storage, then present URL parameters. Missing parameters preserve earlier values; explicit empty optional values can clear them. Invalid values produce field errors before fetching or calculating. Corrupt storage is ignored with feedback, and denied storage still allows use for the current visit.

Temperatures are stored in Celsius. Changing display units converts the current draft without discarding edits. The safety margin is always a Celsius temperature difference. Share links encode recommendation settings, including location, but omit notification settings.

### Forecast freshness

Open-Meteo requests use Unix timestamps and the returned IANA timezone. A ten-second deadline covers both the request and body parsing. The client validates timestamps, arrays, numeric observations, timezone and usable coverage. It requests preceding days so windows can span local midnight; daylight-saving transitions are formatted in the forecast timezone.

The browser tries live weather, then matching shared checker observations, then matching browser cache. Fallback observations are re-evaluated using the visitor's own settings. Data must match the coordinates, be no more than six hours old and still cover usable current or future hours. A matching `check-status.json` marker can confirm a newer successful check without republishing unchanged forecast data.

Only the latest refresh may render or update the cache. Minute ticks recalculate advice and expiry without a network request; visible/manual refreshes fetch again. Unavailable or expired data clears advice, chart and calendar links. Missing current coverage must never be displayed as a valid closed-window decision.

### Interface and accessibility

The layout puts location, current advice, opening times and current comparisons ahead of detailed settings. Light/dark themes use text as well as color to explain status. Advanced limits live in a disclosure; validation reveals hidden errors, preserves help associations and focuses the relevant field.

The chart provides 24/48/72-hour views, numeric axes, reference limits, patterned opening bands and visible gaps in missing series. A native hour slider, Previous/Next controls, details panel and semantic table expose the same observations. Only the SVG has an image role, so the surrounding controls remain accessible. Accessible names begin with visible button text.

Controls and calendar cards retain identity across updates to preserve focus and hour selection. When a focused window expires, focus moves to the next calendar button or list heading. Identical status text is not repeatedly announced.

### Checker publication and delivery

The checker validates settings and usable forecast coverage before publishing. It stages `windows.json`, `windows.ics` and `check-status.json` together, replaces the marker last, and rolls back replacements on failure. Unchanged forecasts and calendar events retain stable content while a successful-check marker advances.

The delivery ledger lives outside `public/`. It records successful sends per event and channel so failed channels can retry without resending confirmed ones. Notification destinations and credentials are represented by hashes in state, never raw values. A crash after provider acceptance but before persistence can still duplicate a delivery.

Scheduled and manual workflows restore the newest eligible ledger artifact, even if its run failed later in publication. Missing or expired state starts fresh; restore/API/schema failures stop before sending. Artifacts have 30-day retention and follow repository access permissions. They are separate from the website, but are not confidential storage in a public repository.

The Pages workflow runs tests first, checks that its revision is current `main` before checker work and again before deployment, and refuses a rejected generated-data push. These checks do not lock the branch. On checker failure, only a complete tracked last-good bundle may deploy. Recovery from a stale run requires a new dispatch from current `main`.

## Operational details

See [Setup and usage](setup.md) for configuration, calendars, notification providers, hosting and troubleshooting, and [Development and verification](development.md) for test coverage and remaining manual checks.
