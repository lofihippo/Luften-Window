# Development and verification

The project uses native JavaScript modules and Node's built-in test runner. No package installation is required.

```sh
npm test
npm run dev
```

`npm test` uses native test discovery. Do not append `test/`, which supported Node versions can interpret as a module path. The development server binds to `127.0.0.1:8080`; `HOST` and `PORT` override that explicitly.

## Verification coverage

The 225-test suite covers settings validation and sharing, psychrometric calculations, forecast normalization and gaps, current-window boundaries, timezone transitions, browser freshness and request races, calendar serialization, notification retries, publication rollback, workflow state and revision checks, and static-server path handling. Notification tests use injected transports rather than real destinations.

The suite has passed on Node 22, 24 and 26. CI tests Node 22/24, while Pages uses Node 24. Integration tests connect the production checker, mocked provider transport, real temporary files and the browser forecast controller. Temporary bare Git repositories exercise stale revisions and rejected concurrent data pushes.

## Browser fixture

```sh
node scripts/browser-fixture.mjs
```

Use `http://127.0.0.1:8082/`, `/Luften-Window/` for a hosted subpath, or `/blocked/` for denied storage. The fixture supplies a synthetic clock and weather without contacting providers. Its controls support offline mode, a seven-hour clock advance, storage reset and calendar-blob inspection. Add `?audit=expanded` to open settings, advanced limits, later windows and the hourly table. This harness is outside the deployed site.

Recorded browser checks cover narrow/wide light/dark layouts, keyboard settings and error recovery, unit changes, unsaved share links, storage denial, fallback expiry, chart pointer/keyboard selection, the hourly table and focus preservation through updates. Lighthouse scored 100 in four theme/viewport cases; see the [audit report](accessibility-audit.md) for exact scope and limitations.

## Release checklist

- [x] Local unit and integration suite, including supported Node versions.
- [x] Responsive, keyboard, state and automated accessibility checks.
- [ ] Confirm the public release's hosted CI, Pages deployment and a subsequent checker run restoring state.
- [ ] Save and import an individual event, and subscribe to the live feed in a native calendar client.
- [ ] Verify physical touch, a real screen reader and speech-control interaction.
- [ ] If notifications are enabled, verify delivery to explicitly designated test destinations.

The remaining manual checks are not implied by passing automated tests. Update this checklist as each check is completed so work can resume from an accurate state.

## Maintenance

Keep deployment defaults at a public city-level example. Avoid committing personal coordinates, destination details, credentials or local delivery state. Personal browser settings do not change the shared feed or configure background notifications.

After changes to recommendation logic, run the shared-core and integration suite. After interaction changes, exercise the browser fixture and applicable accessibility checks. Follow [Setup and usage](setup.md) to deploy or recover from a stale workflow run.
