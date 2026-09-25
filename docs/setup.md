# Setup and usage

Luften-Window works directly in the browser. Choose your region and indoor target, then read the opening and closing times. The default location is New York, a public city example; change it to your region before relying on the forecast.

## Reading the forecast

The status card shows whether a suitable window is open now and when to close it, or the next opportunity. Upcoming cards group consecutive suitable hours. The humidity estimate describes outdoor air at your selected indoor temperature; it is not a measurement of your room.

Choose 24, 48 or 72 hours on the chart. On narrow screens, scroll inside the chart to reach later hours. Select an hour by clicking or tapping, using Previous/Next, or focusing the hour slider and pressing arrow keys. Home/End selects the first/last hour; Escape hides details. The hourly table provides the same values and reasons in text.

## Location and privacy

Personal settings stay in your browser's local storage unless you share them. Forecast requests send your selected coordinates to Open-Meteo. A copied share link includes coordinates and recommendation settings, so use a city or region rather than a home address when sharing publicly.

The checked-in defaults, generated forecast and shared calendar are public deployment data. Keep notification credentials in environment variables or repository Actions secrets. Background notifications are disabled in the example configuration.

## Configuration

Edit `public/config.json` for deployment defaults, or use the in-app settings panel which persists to `localStorage`.

| Setting | Meaning |
| --- | --- |
| `location` | Latitude, longitude, label |
| `units` | `"F"` or `"C"` (display only; internal is °C) |
| `indoorTempC` | Assumed indoor temperature in °C |
| `targetRH` | Target indoor relative humidity (%) |
| `coldestSurfaceC` | Coldest indoor surface temp (basement slab/walls), optional |
| `marginC` | Safety margin subtracted from the dew-point limit (°C) |
| `minOutdoorC` / `maxOutdoorC` | Allowable outdoor temperature range (°C) |
| `maxRainProb` | Max forecast rain probability (%) |
| `maxWindKmh` | Max outdoor wind (km/h) |
| `minWindowHours` | Minimum length of a valid window |
| `requireDrying` | If true, use the indoor reading to require drying |
| `indoorReading` | `{ tempC, rh }` current indoor measurement, optional |
| `forecastDays` | How many forecast days to consider |
| `notify` | `enabled`, `leadHours`, `realtime`, `digest` |

## Development

Requires Node 22+; CI checks Node 22 and 24, and deployed jobs use Node 24.

```bash
npm run dev     # serve public/ at http://localhost:8080
npm test        # run the test suite (node --test)
npm run check   # run the checker once, writes public/data/windows.json
npm run check:loop   # run the checker every OW_INTERVAL_MIN minutes
```

The development server listens on `127.0.0.1:8080` by default. Set `HOST` and `PORT` explicitly to change the bind address or port. A local checker run writes public forecast files under `public/data/` and keeps its delivery ledger in private `.state/state.json`.

No package installation is needed. `npm test` uses native test discovery; do not append `test/`, which Node 22/24 treats as a module path instead of discovering this suite.

For repeatable browser acceptance without weather or notification requests, run:

```bash
node scripts/browser-fixture.mjs
```

Open `http://127.0.0.1:8082/`, `http://127.0.0.1:8082/Luften-Window/` for a Pages-style subpath, or `http://127.0.0.1:8082/blocked/` for denied storage. The fixture intercepts fetches, supplies a fixed forecast/clock, and exposes controls to go offline, advance seven hours, clear its storage, and inspect the generated calendar blob. Go offline then Refresh to exercise the browser cache; advance the clock to check expiry. This origin has separate storage from the development app. Stop the server with Ctrl-C. It is a manual harness outside `public/`, not a deployed feature or an automated browser test.

Add `?audit=expanded` to keep the settings, advanced limits, later windows and hourly table open for accessibility auditing. The [recorded Lighthouse audit](accessibility-audit.md) includes reproducible commands and distinguishes automated results from remaining manual checks.

## Deploying to GitHub Pages

Confirm that the repository is eligible first: GitHub Free supports Pages from public repositories; private repositories require a supported paid plan. See [GitHub Pages availability](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages). Publishing the repository itself exposes its files and commit history, so keep the existing visibility unless you intend that change.

1. Push this repository to GitHub (default branch `main`).
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. (Optional) Add the `NTFY_TOPIC` secret under **Settings → Secrets and variables → Actions**. Use a long random topic name — ntfy topics are public. Other optional secrets: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. Set a public city-level example in `public/config.json`, then commit. These coordinates and the generated calendar are public. Visitors can select their own region in the browser.
5. The `pages.yml` workflow runs tests before deployment. On schedule or manual dispatch from `main`, it restores the latest delivery-state artifact, runs the checker, saves the state, validates the JSON/calendar/check marker bundle, commits changed public data, and deploys to `https://<user>.github.io/<repo>/`. The ledger is separate from the public Pages files; Actions artifact access still follows repository permissions.

The workflow verifies that its checkout is current `main` before checker work and again before Pages publication. These are point-in-time checks, not a lock on the branch. If a queued run or rerun is stale, or a concurrent change causes its data push to fail, start a **new** workflow with **Actions → pages → Run workflow → main**. Rerunning the old job retains its old revision and can fail the guard again. Do not force-push generated data to resolve this. A saved delivery-state artifact is available for the next eligible run even if publication failed later.

If a checker run fails, the workflow discards its partial public files and deploys only a complete tracked last-good bundle. If no complete tracked bundle exists yet, it skips that deployment. The separate state artifact is uploaded before public verification so confirmed sends can survive a later failure. Artifacts are kept for 30 days; if none remains, an eligible notification may be sent again. GitHub Actions artifacts may be readable by people with repository access, so the ledger contains hashes rather than raw destinations or credentials; use a long random ntfy topic. A crash after a provider accepts a message but before state persistence can still duplicate it.

Scheduled runs are best-effort, may be delayed, and are auto-disabled after 60 days without repo activity in public repos. Successful checker runs update the check marker and normally create a data commit; if the workflow is ever disabled, re-enable it from the Actions tab.

## Other static hosting

Publish the contents of `public/` as-is with your existing static host. The app uses relative URLs and works at a domain root or repository subpath. The browser fetches weather and computes recommendations directly, so the app does not require a running Node server.

For a shared forecast, calendar feed, or notifications, optionally run `npm run check` on Node 22+, or keep `npm run check:loop` running to check every `OW_INTERVAL_MIN` minutes (default 30). These commands read `public/config.json` and write the JSON, ICS, and check-status files under `public/data/`. Publish those files together. Keep the delivery ledger at `.state/state.json` outside the served tree and retain it across checker restarts. Supply notification credentials through the checker's process environment.

## Notifications

Notifications use the checker job. Configure channels via environment variables:

| Channel | Variables |
| --- | --- |
| ntfy | `NTFY_TOPIC`, `NTFY_SERVER` (default `https://ntfy.sh`) |
| Email (Resend) | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO` |
| Discord | `DISCORD_WEBHOOK_URL` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

- `notify.realtime` controls "window starting soon"/"closing soon" alerts.
- `notify.digest` sends a daily summary at or after the configured hour in the forecast location's timezone, including suitable windows through 09:00 local time tomorrow.
- The checker records successful deliveries per event and channel, retrying failed channels without resending confirmed ones. Its local default is `.state/state.json`, and Actions saves a separate state artifact across runner instances. No delivery ledger is served with the site.

Set `notify.enabled: true` in the checker's `public/config.json`, then enable `notify.realtime` and/or `notify.digest.enabled`. Browser settings do not configure these background alerts. At least one channel needs all of its listed variables:

- **ntfy:** choose a long random topic, subscribe to that exact topic in the [ntfy phone app](https://docs.ntfy.sh/subscribe/phone/), and put the topic name in `NTFY_TOPIC`. The checker defaults to `https://ntfy.sh`; a custom `NTFY_SERVER` must match the subscription server and allow this unauthenticated publisher. The stock Pages workflow uses the default server.
- **Resend email:** [verify a sending domain](https://resend.com/docs/dashboard/domains/introduction) and create an [API key](https://resend.com/docs/dashboard/api-keys/introduction). Set `RESEND_API_KEY`, `EMAIL_FROM` to an address at that domain, and `EMAIL_TO` to one address or a comma-separated list.
- **Discord:** in your server's **Server Settings → Integrations**, create a webhook, select its destination channel, and copy its URL into `DISCORD_WEBHOOK_URL`. Treat that URL as a credential. See [Discord's webhook setup](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).
- **Telegram:** create a bot through **@BotFather** and save its token as `TELEGRAM_BOT_TOKEN`. Start a conversation with the bot (or add it to your intended group and send it a message), then obtain that message's `chat.id` via the Bot API `getUpdates` method and save it as `TELEGRAM_CHAT_ID`. Keep the token private; an existing bot webhook prevents `getUpdates`, so use a dedicated bot or your existing bot integration to obtain the ID. See the [bot tutorial](https://core.telegram.org/bots/tutorial) and [getUpdates reference](https://core.telegram.org/bots/api#getupdates).

For Pages, enter these values as repository Actions secrets; for a local Node checker, supply them through its process environment. Running `npm run check` with enabled channels can send real messages.

### Calendar subscription

Once the checker has run, `public/data/windows.ics` is generated. The app offers its subscription link only while the shared checker forecast and a structurally valid feed are available. `public/data/check-status.json` records the last successful check separately, so an unchanged forecast remains fresh without rewriting JSON or ICS. This feed follows the checker's location and settings; changing personal settings in the browser does not change it. Per-window calendar downloads reflect your current browser settings.

Use **Copy link** in the shared calendar panel, or the deployed feed URL: `https://<user>.github.io/<repo>/data/windows.ics` for project Pages, or `https://<host>/data/windows.ics` for a root deployment. Keep the repository subpath. For ongoing updates, add a URL subscription; importing an individual `.ics` download makes a one-time copy.

The app copies a `webcal://` link for calendar apps. If a service asks for an HTTP URL, replace `webcal://` with the deployed site's `https://` scheme and leave the rest of the URL unchanged.

- **Apple Calendar on Mac:** choose **File → New Calendar Subscription**, paste the feed URL, and select Subscribe. Choose the account and refresh options offered by Calendar. See [Apple's subscription guide](https://support.apple.com/en-ie/102301).
- **Google Calendar on a computer:** next to **Other calendars**, choose **+ → From URL**, paste the public feed URL, and select Add calendar. See [Google's instructions](https://support.google.com/calendar/answer/37100?hl=en).
- **Outlook on the web:** open Calendar, choose **Add calendar → Subscribe from web**, paste the URL, and save. See [Microsoft's instructions](https://support.microsoft.com/en-us/outlook/import-or-subscribe-to-a-calendar-in-outlook-com-or-outlook-on-the-web).

Cloud calendar services need a publicly reachable URL; `localhost` and a private LAN address will not work for them. Refresh timing belongs to the calendar service, so subscriptions may lag behind this app; Outlook documents that updates can take more than 24 hours. Use the app or checker alerts for the current opening decision.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Forecast unavailable or expired | Refresh and inspect the source message. Fallback data must match the location, remain within the six-hour freshness limit, and contain usable remaining coverage. The checker must run successfully to renew shared data. |
| No notification | Confirm `notify.enabled`, the desired realtime/digest flag, every variable required by that channel, and an eligible window or local digest hour. Check `notify[channel]` logs. Confirmed events are deliberately not resent; a provider failure retries on a later eligible run. |
| Shared calendar link missing | Check that `data/windows.json`, `data/check-status.json`, and `data/windows.ics` were published together and are fresh. A live browser forecast alone does not create the shared feed. |
| Calendar shows different windows | The feed uses checker settings, while the app can use personal settings. Also check the calendar service's refresh delay and whether the calendar was imported instead of subscribed. |
| Settings disappear after reload | Read the storage feedback. Save still applies for the visit when storage is denied; a share link can preserve the draft settings. |
| Pages revision guard or data push fails | Start a new `pages` workflow from current `main`; do not rerun a stale revision or force-push it. See deployment steps above. |

