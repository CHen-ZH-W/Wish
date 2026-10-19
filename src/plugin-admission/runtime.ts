import type { Context, Fiber } from "@deepseek-ai/cordis";
import { HOST_PLUGIN_CATALOG, MODEL_TOOL_PLUGIN_CATALOG } from "../boot/plugin-catalog.js";
import type { WishPluginManifestView } from "../boot/plugin-control/types.js";
import { compatible, deny, HOST_SERVICE_CONTRACTS, type PluginServiceContracts, type ServiceContract } from "./contracts.js";

function firstParty(name: string): boolean {
  return Object.entries({ ...HOST_PLUGIN_CATALOG, ...MODEL_TOOL_PLUGIN_CATALOG }).some(([alias, module]) =>
    name === `cordis:${alias}` || name === (module.startsWith(".") ? new URL(module, new URL("../boot/plugin-catalog.js", import.meta.url)).href : import.meta.resolve(module)));
}
function shape(value: unknown, contract: ServiceContract): boolean {
  return value !== undefined && value !== null && contract.methods.every(method => typeof (value as Record<string, unknown>)[method] === "function");
}
/** Validate captured providers rather than resolving a same-named global service. */
export function verifyPluginContracts(root: Context, fiber: Fiber, manifest: Pick<WishPluginManifestView, "id" | "contracts">, strict = false): void {
  const contracts: PluginServiceContracts = manifest.contracts ?? { requires: {}, provides: {} };
  for (const name of Object.keys(fiber.inject)) if (!Object.hasOwn(contracts.requires, name) && (manifest.contracts || strict)) deny("plugin_contract_inject_undeclared", `${manifest.id}:${name}`);
  const inspection = root.get("pluginInspection")?.inspect();
  for (const [name, required] of Object.entries(contracts.requires)) {
    if (!Object.hasOwn(fiber.inject, name)) deny("plugin_contract_inject_missing", `${manifest.id}:${name}`);
    const impl = fiber.store?.[name];
    if (!impl) { if (required.optional) continue; deny("plugin_contract_provider_missing", `${manifest.id}:${name}`); }
    const provider = impl.fiber;
    if (provider.uid === fiber.uid) deny("plugin_contract_self_dependency", name);
    const entry = inspection?.entries.find(item => item.fiberId === provider.uid);
    const declared = entry?.manifest?.contracts?.provides[name] ??
      (entry && firstParty(entry.name) ? HOST_SERVICE_CONTRACTS[name] : undefined);
    if (!declared || !compatible(declared, required)) deny("plugin_contract_version_mismatch", `${manifest.id}:${name}`);
    if (!shape(impl.value, required)) deny("plugin_contract_interface_mismatch", `${manifest.id}:${name}`);
  }
  for (const [name, provided] of Object.entries(contracts.provides)) {
    const impl = fiber.store?.[name];
    if (impl?.fiber.uid !== fiber.uid || !shape(impl.value, provided)) deny("plugin_contract_interface_mismatch", `${manifest.id}:${name}`);
  }
}
