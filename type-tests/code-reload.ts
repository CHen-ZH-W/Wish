import type { CodeReloadInspection } from "../src/boot/plugin-control/code-reload.js";
import type { BootstrapOptions, BootstrappedProcess } from "../src/boot/bootstrap.js";

declare const inspection: CodeReloadInspection;
declare const boot: BootstrappedProcess;
// @ts-expect-error public inspection cannot attach a persistence transaction
inspection.attachTransaction({ run: async () => {} });
const snapshot = boot.codeReload.snapshot();
inspection.subscribe(() => { void snapshot.phase; });
// @ts-expect-error observations do not authorize code application
inspection.coordinate(new Map(), new AbortController().signal, async () => {});
// @ts-expect-error the public reload snapshot is immutable
snapshot.phase = "succeeded";
if (boot.pluginManagement?.snapshot().codeReload) {
  // @ts-expect-error HTTP management observations cannot mutate the reload owner
  boot.pluginManagement.snapshot().codeReload!.entryIds.push("include:tool-read");
}
// @ts-expect-error no per-request unsafe HMR bypass on bootstrap
const unsafe: BootstrapOptions = { surface: "cli", allowUnsafeCodeReload: true };
void unsafe;
