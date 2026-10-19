import type { PluginServiceContracts, ArchitectureReport, CandidateQualityGate } from "wish/plugins/admission";
import type { WishPluginManifest } from "wish/plugins/manifest";

const contracts: PluginServiceContracts = {
  requires: { compaction: { version: 1, methods: ["registerStrategy"] } },
  provides: {},
};
const gate: CandidateQualityGate = { minimumSuccessRate: 1, maximumSuccessRateRegression: 0, maximumCostByCurrency: { USD: 1 } };
declare const manifest: WishPluginManifest;
declare const report: ArchitectureReport;
// @ts-expect-error Service contracts are immutable after admission.
contracts.requires.compaction!.methods.push("open");
// @ts-expect-error Service versions are integer protocol identifiers, not semver ranges.
contracts.requires.compaction!.version = "^1";
// @ts-expect-error Profile permissions cannot be changed through a Manifest projection.
manifest.contracts = contracts;
// @ts-expect-error Archived architecture evidence cannot be edited in place.
report.runtimeFiles.push("hidden.ts");
// @ts-expect-error Experiment resource budgets are immutable facts.
gate.maximumCostByCurrency!.USD = 2;
