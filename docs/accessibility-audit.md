# Accessibility audit — 2026-09-25

Lighthouse 13.5.0 scored **100/100** in all four final runs using Headless Chrome 153 on macOS. Every applicable automated accessibility audit passed, including the unweighted experimental label/name check. No runtime error or run warning was reported. The audit screenshots were inspected to confirm the rendered theme and expanded content.

| Case | Viewport | Path | Disclosures | Passed audits | Score |
| --- | --- | --- | --- | --- | --- |
| Mobile light | 375 × 812 | `/` | Expanded | 37 | 100 |
| Mobile dark | 375 × 812 | `/Luften-Window/` | Default | 33 | 100 |
| Desktop light | 1280 × 900 | `/` | Default | 33 | 100 |
| Desktop dark | 1280 × 900 | `/Luften-Window/` | Expanded | 37 | 100 |

“Expanded” means settings, advanced limits, later windows and the hourly table are open. This exposes controls and table semantics that an initial-page audit would otherwise miss. All cases use the production HTML, CSS and browser modules with the local fixture's synthetic weather and clock. The fixture controls are also present; this is not an audit of a deployed site.

## Issue found and fixed

The initial mobile audit on 2026-09-24 also scored 100, but its unweighted `label-content-name-mismatch` audit failed. Calendar buttons displayed “Add to calendar” while their accessible names inserted the date between those words. Chart buttons displayed “24h”/“48h”/“72h” while their names used “Show 24 hours”, and so on.

The names now start with the visible label: `Add to calendar: <window range>` and `24h forecast` / `48h forecast` / `72h forecast`. The final reports show the mismatch resolved. Including the visible text in the accessible name supports speech activation; see [W3C's Label in Name guidance](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html).

## Reproduce

Start the fixture in one terminal from the repository root:

```sh
node scripts/browser-fixture.mjs
```

The fixture serves only loopback and supplies data without contacting weather or notification providers. The `?audit=expanded` option opens disclosures only in this harness. Production pages ignore it.

In a second terminal, install the audit tool in a temporary directory. This adds no project or global dependency:

```sh
audit_tools="$(mktemp -d)"
npm install --prefix "$audit_tools" lighthouse@13.5.0 --no-save --package-lock=false --ignore-scripts --no-audit --no-fund
export CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

audit_page() {
  audit_name="$1"
  audit_url="$2"
  audit_flags="$3"
  shift 3
  node "$audit_tools/node_modules/lighthouse/cli/index.js" "$audit_url" \
    --only-categories=accessibility --chrome-flags="$audit_flags" \
    --screenEmulation.deviceScaleFactor=1 --output=json --output=html \
    --output-path="$audit_tools/$audit_name" --quiet "$@"
}

audit_page mobile-light-expanded 'http://127.0.0.1:8082/?audit=expanded' \
  '--headless --blink-settings=preferredColorScheme=1' \
  --screenEmulation.width=375 --screenEmulation.height=812
audit_page mobile-dark 'http://127.0.0.1:8082/Luften-Window/' \
  '--headless --force-dark-mode' \
  --screenEmulation.width=375 --screenEmulation.height=812
audit_page desktop-light 'http://127.0.0.1:8082/' \
  '--headless --blink-settings=preferredColorScheme=1' \
  --preset=desktop --screenEmulation.width=1280 --screenEmulation.height=900
audit_page desktop-dark-expanded 'http://127.0.0.1:8082/Luften-Window/?audit=expanded' \
  '--headless --force-dark-mode' \
  --preset=desktop --screenEmulation.width=1280 --screenEmulation.height=900
```

These are the flags verified with this Chrome version. The default preference on the audit Mac was dark, so an unqualified headless launch did not verify light mode. Inspect screenshots after reruns; do not infer theme from a report filename. Chromium defines its light `preferredColorScheme` value as 1 ([enum](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/public/mojom/css/preferred_color_scheme.mojom)). For Lighthouse CLI usage, see the [official guide](https://github.com/GoogleChrome/lighthouse/blob/main/readme.md).

Inspect every audit with a numeric score below 1, not just the category score. Stop the fixture with Ctrl-C when finished. The original full JSON/HTML reports and screenshots were saved as temporary local artifacts. The metadata below preserves the audited source and report identities. The default location and notification opt-in were subsequently changed for the public example; the interface was unchanged.

## Limits

- This is an automated accessibility audit of deterministic fixture states, not WCAG certification or a full production-site audit.
- Lighthouse retains ten manual checks covering focus, tab/visual order, affordances, landmarks, offscreen content and custom controls. Recorded keyboard, responsive, focus and state checks remain separate evidence.
- A real screen reader, speech-control software, physical touch, native calendar save/import, live notifications and hosted Actions/Pages have not been verified by these audits.
- Lighthouse was installed only as temporary verification tooling. The app still has zero package dependencies and no build step.

## Recorded identities

| Case | Audit time (UTC) | SHA256 of full JSON report |
| --- | --- | --- |
| mobile-light-expanded | 2026-09-25T05:11:13.019Z | `4a4f20fe319d8d7f68c7a375fd409765ceeb1c815d2e530a7aa6fd9a62fed78f` |
| mobile-dark | 2026-09-25T05:10:07.332Z | `f5616a47e03acf7f07ed3b347f8039dd80ef291e9bbc3491051b922f9610d6d8` |
| desktop-light | 2026-09-25T05:11:15.420Z | `ca9737b05022bc63c31e40163d2425aef74dd2fee0c3f02b95c5500f27c2eebe` |
| desktop-dark-expanded | 2026-09-25T05:09:15.165Z | `faaddff77dfa2bce3b95a56c5586fcb4afc4bc995e53128a1c876f50a36ecb50` |

| Audited source | SHA256 |
| --- | --- |
| `public/index.html` | `03c8486eda05e647f29a90c6f361ec08a5eaa89fad4756938acda4aa6604da1c` |
| `public/app.js` | `bfcc1bcc4bdc461a4e8ecd99c4c3418340054f55e1235357605f549b779ca92c` |
| `public/styles.css` | `d4acc16f687f9a4b8c6f738221e8c43e5453665ca7e3870279cfba60b5230c1c` |
| `public/ui/forecast-chart.js` | `9783b8dd1c79638c5b369020dcd6f110c132d92dfbd5213470b235aa627667fb` |
| `public/ui/forecast-chart.css` | `f3b987a3fdb44e70430fa297c07bc2b8c7a7ce383afa6df78a11674ecbea90e7` |
| `public/config.json` | `254725ff567f9ef3f6f78b2fd5a3d7ee8f1fa4ea3b4bc29086ecd2bd18f30308` |
| `scripts/browser-fixture.mjs` | `1f8259f9f6f4eb690b379296c023f0c0589872136be09b1b63e044b94b94871c` |
