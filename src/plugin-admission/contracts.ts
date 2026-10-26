/** Integer versions identify service protocols, independently of package/state versions. */
export interface ServiceContract {
  readonly version: number;
  readonly methods: readonly string[];
}
export interface RequiredServiceContract extends ServiceContract { readonly optional?: true }
export interface PluginServiceContracts {
  readonly requires: Readonly<Record<string, RequiredServiceContract>>;
  readonly provides: Readonly<Record<string, ServiceContract>>;
}
export class PluginAdmissionError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}
export function deny(code: string, detail?: string): never { throw new PluginAdmissionError(code, detail); }
export function parseContracts(value: unknown): PluginServiceContracts {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("plugin_contract_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["requires", "provides"].includes(key))) deny("plugin_contract_invalid");
  const parse = (raw: unknown, required: boolean): Record<string, RequiredServiceContract> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 64) deny("plugin_contract_invalid");
    return Object.freeze(Object.fromEntries(Object.entries(raw).map(([name, data]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,95}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) || !data || typeof data !== "object" || Array.isArray(data)) deny("plugin_contract_invalid");
      const item = data as Record<string, unknown>;
      if (Object.keys(item).some(key => !["version", "methods", ...(required ? ["optional"] : [])].includes(key)) ||
        !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !Array.isArray(item.methods) || item.methods.length > 64 ||
        item.methods.some(method => typeof method !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,95}$/.test(method) || ["constructor", "prototype", "__proto__"].includes(method)) ||
        new Set(item.methods).size !== item.methods.length || item.optional !== undefined && item.optional !== true) deny("plugin_contract_invalid");
      return [name, Object.freeze({ version: Number(item.version), methods: Object.freeze([...item.methods as string[]].sort()), ...(item.optional === true ? { optional: true as const } : {}) })];
    })));
  };
  const requires = parse(input.requires, true), provides = parse(input.provides, false);
  if (Object.keys(requires).some(name => Object.hasOwn(provides, name))) deny("plugin_contract_self_dependency");
  return Object.freeze({ requires, provides });
}

/** Stable first-party service protocols. Only these public methods may be consumed. */
export const HOST_SERVICE_CONTRACTS: Readonly<Record<string, ServiceContract>> = Object.freeze(Object.fromEntries(Object.entries({
  compaction: { version: 1, methods: ["registerStrategy", "registerScoped", "selectScoped", "open"] },
  tools: { version: 1, methods: ["register", "registerScoped", "registryFor"] },
  context: { version: 1, methods: ["registerProvider", "registerProviderScoped", "registerObserver", "open"] },
  systemPrompt: { version: 1, methods: ["register", "registerScoped", "capture", "assemble", "assembleInstructions"] },
  skills: { version: 1, methods: ["registerSource"] },
  models: { version: 1, methods: ["open", "load", "register", "registerPricing"] },
  storageBackend: { version: 1, methods: ["acquire", "resolve", "backend"] },
  filesystem: { version: 1, methods: ["preflight", "resolve", "readFile", "writeFile", "stat"] },
  webFetch: { version: 1, methods: ["fetch"] },
  webSearch: { version: 1, methods: ["search"] },
  timer: { version: 1, methods: ["timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"] },
}).map(([name, contract]) => [name, Object.freeze({ ...contract, methods: Object.freeze(contract.methods) })])));

export function compatible(provided: ServiceContract, required: ServiceContract): boolean {
  return provided.version === required.version && required.methods.every(method => provided.methods.includes(method));
}

/** Static graph covers manifest-owned services; Cordis bindings remain authoritative at activation. */
export function checkContractTopology(entries: readonly { readonly id: string; readonly contracts?: PluginServiceContracts; readonly isolation?: Readonly<Record<string, string>> }[]): void {
  const key = (entry: typeof entries[number], name: string) => JSON.stringify([name, entry.isolation?.[name] ?? "root"]);
  const providers = new Map<string, { id: string; contract: ServiceContract }[]>();
  for (const entry of entries) for (const [name, contract] of Object.entries(entry.contracts?.provides ?? {})) {
    const service = key(entry, name), items = providers.get(service) ?? []; items.push({ id: entry.id, contract }); providers.set(service, items);
  }
  const graph = new Map<string, string[]>();
  for (const entry of entries) {
    const edges: string[] = [];
    for (const [name, requirement] of Object.entries(entry.contracts?.requires ?? {})) {
      const candidates = providers.get(key(entry, name)) ?? [];
      if (candidates.length === 1) {
        if (!compatible(candidates[0]!.contract, requirement)) deny("plugin_contract_version_mismatch", `${entry.id}:${name}`);
        edges.push(candidates[0]!.id);
      } else if (!candidates.length) {
        const host = HOST_SERVICE_CONTRACTS[name];
        if (host && !compatible(host, requirement)) deny("plugin_contract_version_mismatch", `${entry.id}:${name}`);
        if (!host && !requirement.optional) deny("plugin_contract_provider_missing", `${entry.id}:${name}`);
      }
    }
    graph.set(entry.id, edges);
  }
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) deny("plugin_contract_dependency_cycle", id);
    if (done.has(id)) return; visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id); done.add(id);
  };
  for (const entry of entries) visit(entry.id);
}
