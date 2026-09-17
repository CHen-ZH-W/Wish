import type { Context } from "@deepseek-ai/cordis";
import type { BootstrappedProcess } from "../src/boot/bootstrap.js";
import type { PluginInspection, PluginInspectionSnapshot } from "../src/boot/plugin-control/types.js";
import type { PluginConfigurationState, PluginOperationState, PluginSelection } from "../src/boot/plugin-control/management-types.js";
import { assessPluginDisable } from "../src/boot/plugin-control/assessment.js";

declare const booted: BootstrappedProcess;
declare const root: Context;
const port: PluginInspection = booted.plugins;
const snapshot: PluginInspectionSnapshot = root.pluginInspection.inspect();
const safety: "not-assessed" = port.previewDisable("include:provider").safety;
// @ts-expect-error Inspection cannot change the Loader tree.
port.disable("include:provider");
// @ts-expect-error Observations cannot expose arbitrary plugin configuration.
snapshot.entries[0]!.config;
// @ts-expect-error Snapshot arrays are immutable.
snapshot.entries.push({});
// @ts-expect-error Snapshot fields are immutable.
snapshot.entries[0]!.enabled = true;
void safety;

const selection: PluginSelection = { instanceId: snapshot.instanceId, entryIds: ["include:provider"] };
const assessment = assessPluginDisable(snapshot, selection);
const executionCheck: "requires-execution-check" = assessment.safety;
// @ts-expect-error Feature membership must explicitly name scoped Loader entries.
const byName: PluginSelection = { module: "skills" };
// @ts-expect-error A management preference is not an observed Fiber state.
const wrongPreference: PluginConfigurationState = { preference: "pending", persistence: { status: "unmanaged" } };
// @ts-expect-error Success requires independent runtime, cleanup and persistence confirmation.
const premature: PluginOperationState = { phase: "succeeded", runtime: "confirmed" };
const confirmed: PluginOperationState = { phase: "succeeded", runtime: "confirmed", cleanup: "confirmed", persistence: "saved" };
// @ts-expect-error Consumers cannot rewrite an assessment's diagnostics.
assessment.conditions.push({});
void [executionCheck, byName, wrongPreference, premature, confirmed];

const collection = booted.pluginLifecycle.collect(selection);
// @ts-expect-error The public read port cannot register arbitrary callback code.
booted.pluginLifecycle.register(root, () => ({ disposition: "direct", code: "unsafe" }));
// @ts-expect-error Lifecycle observation is not stop authority.
booted.pluginLifecycle.disable(selection);
void collection;

const operation = booted.pluginStops.disable(selection);
const currentStop = booted.pluginStops.current();
// @ts-expect-error Clients cannot supply Host recovery/configuration approval.
booted.pluginStops.disable(selection, { recovery: "available", configuration: "managed" });
// @ts-expect-error No arbitrary callback/Loader entry mutation on the public control port.
booted.pluginStops.reserve(selection);
// @ts-expect-error Operation receipts are immutable.
if (currentStop) currentStop.state = { phase: "checking" };
void operation;
