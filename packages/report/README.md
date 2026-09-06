# uiwitness-report

Deterministic transformation and self-contained offline HTML generation for validated UIWitness schema-v1/v2 reports, privacy manifests, and optional State Contract Guard verdicts.

```ts
import {
  renderReportHtml,
  transformReport,
  type ContractVerdictReportInput,
} from "uiwitness-report";

const html = renderReportHtml(report, {
  contractVerdict: verdict satisfies ContractVerdictReportInput,
});
```

The renderer accepts schema-v1 reports whose screenshots use either `.uiwitness/artifacts/**` or the legacy `.statecraft/artifacts/**` root, plus schema-v2 reports with explicit capture/omission status. It preserves accepted roots when deriving links and can render the selector-free evidence privacy manifest.

When `contractVerdict` is provided, the report validates and leads with the contract promise, canonical findings, exact allowed commands, incomplete-run reasons with deterministic explanations, and contract/config/run digests before retaining the existing evidence matrix and inspector. Known-failure entries include owner, reason, expiry, exact expected/actual codes, UTC lifecycle, and eligibility-aware renewal or recovery guidance. The contract ledger has independent coordinate-text and finding-type filters whose valid state persists in the local URL. Omitting `contractVerdict` preserves the execution-only report.

Most users should install [`uiwitness`](https://www.npmjs.com/package/uiwitness). Use this package directly when embedding UIWitness's report renderer in another local tool.

See the [report API documentation](https://github.com/RujitRaval/uiwitness/blob/main/docs/engineering/REPORT_API.md).
