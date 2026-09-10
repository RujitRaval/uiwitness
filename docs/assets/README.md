# Launch Asset Review

The checked-in README images were generated from UIWitness's deterministic Northline example and manually reviewed on 2026-09-08. Northline, Lumen Supply Company and Northeast Independent Retail Cooperative, Mara Chen, customer ID `cus-1048`, loopback URLs, dates, metrics, and diagnostics visible in these images all originate in the repository's fictional example fixtures. No customer, prospect, credential, production endpoint, or private application data is present.

| Asset | Reviewed SHA-256 |
| --- | --- |
| `uiwitness-report-overview.png` | `5334de21b141fc5617184f9724d680bc1369d6826fb87ca89939912fa8c1d10e` |
| `uiwitness-failure-detail.png` | `ddd9e5f3a5a509a9c9cafe719cdddec1813322b4ccd755210fe746495ab28742` |

`node --test scripts/capture-launch-assets.test.mjs` locks these exact reviewed bytes. If either digest changes, regenerate from the complete 60-cell Northline scan, confirm the expected 56 passes and four deliberate failures, visually inspect every changed pixel for fictional-only data, and then update this review and its test baseline together.
