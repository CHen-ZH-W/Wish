import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WishPluginManifestView } from "./types.js";

export type { WishPluginManifestView } from "./types.js";

export const WISH_PLUGIN_API_VERSION = "wish.plugin/v1" as const;

export const WISH_PLUGIN_CAPABILITIES = Object.freeze([
  "filesystem.read",
  "filesystem.write",
  "process.exec",
  "network.connect",
  "web.search",
  "web.fetch",
  "external.side_effect",
  "runtime.read",
  "runtime.control",
] as const);

export type WishPluginCapability = typeof WISH_PLUGIN_CAPABILITIES[number];
export type WishPluginReplacement = "drain" | "generation";

export type WishPluginState =
  | { readonly mode: "stateless" }
  | {
      readonly mode: "versioned";
      readonly schemaVersion: number;
      readonly readableVersions: readonly number[];
    };

export interface WishPluginConfigSchema {
  readonly type: "null" | "boolean" | "integer" | "number" | "string" | "array" | "object";
  readonly description?: string;
  readonly const?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: WishPluginConfigSchema;
  readonly properties?: Readonly<Record<string, WishPluginConfigSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | WishPluginConfigSchema;
}

export interface WishPluginManifest {
  readonly apiVersion: typeof WISH_PLUGIN_API_VERSION;
  readonly id: string;
  readonly displayName?: string;
  /** Portable module path relative to this manifest. */
  readonly entry: string;
  readonly managementClass: "managed";
  readonly replacement: WishPluginReplacement;
  readonly configSchema: WishPluginConfigSchema;
  /** Upper bound declared by the plugin; it never grants authority. */
  readonly permissions: { readonly capabilities: readonly WishPluginCapability[] };
  /** v1 plugins execute in the Host and therefore must be explicitly trusted. */
  readonly sandbox: {
    readonly isolation: "trusted-in-process";
    readonly filesystem: "none" | "capability-grant";
    readonly process: "none" | "capability-grant";
    readonly network: "none" | "capability-grant";
  };
  readonly state: WishPluginState;
}

export interface LoadedWishPluginManifest {
  readonly manifest: WishPluginManifest;
  readonly view: WishPluginManifestView;
  readonly filename: string;
  readonly digest: string;
}

export class WishPluginManifestError extends Error {
  constructor(readonly code: string) { super(code); }
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const manifestKeys = new Set([
  "apiVersion", "id", "displayName", "entry", "managementClass", "replacement",
  "configSchema", "permissions", "sandbox", "state",
]);
const schemaKeys = new Set([
  "type", "description", "const", "enum", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "items", "properties", "required", "additionalProperties",
]);
const capabilities = new Set<string>(WISH_PLUGIN_CAPABILITIES);

/** Parse a static manifest and verify that it describes this exact deployment entry. */
export function readWishPluginManifest(
  reference: string,
  profileFilename: string,
  entryName: string,
  config: unknown,
): LoadedWishPluginManifest {
  const filename = resolveManifestFilename(reference, profileFilename);
  const stats = statSync(filename);
  if (!stats.isFile() || stats.size > 256 * 1024) throw new WishPluginManifestError("plugin_manifest_invalid");
  const content = readFileSync(filename, "utf8");
  let input: unknown;
  try { input = JSON.parse(content) as unknown; }
  catch { throw new WishPluginManifestError("plugin_manifest_invalid"); }
  const manifest = parseWishPluginManifest(input);
  if (resolveEntry(entryName, profileFilename) !== resolveEntry(manifest.entry, filename)) {
    throw new WishPluginManifestError("plugin_manifest_entry_mismatch");
  }
  assertWishPluginConfig(manifest.configSchema, config ?? {});
  return Object.freeze({
    manifest,
    view: Object.freeze({
      apiVersion: manifest.apiVersion,
      id: manifest.id,
      displayName: manifest.displayName ?? null,
      replacement: manifest.replacement,
      capabilities: manifest.permissions.capabilities,
      isolation: manifest.sandbox.isolation,
      state: manifest.state,
    }),
    filename,
    digest: createHash("sha256").update(content).digest("hex"),
  });
}

export function parseWishPluginManifest(input: unknown): WishPluginManifest {
  const value = record(input, "plugin_manifest_invalid");
  exactKeys(value, manifestKeys, "plugin_manifest_invalid");
  if (value.apiVersion !== WISH_PLUGIN_API_VERSION) throw new WishPluginManifestError("plugin_manifest_api_unsupported");
  const id = identifier(value.id, "plugin_manifest_invalid");
  const displayName = value.displayName === undefined ? undefined : text(value.displayName, "plugin_manifest_invalid", 120);
  const entry = text(value.entry, "plugin_manifest_invalid", 512);
  if (!entry.startsWith("./") || entry.includes("\0")) throw new WishPluginManifestError("plugin_manifest_invalid");
  if (value.managementClass !== "managed" || (value.replacement !== "drain" && value.replacement !== "generation")) {
    throw new WishPluginManifestError("plugin_manifest_invalid");
  }
  const configSchema = parseSchema(value.configSchema, { nodes: 0 }, 0);
  if (configSchema.type !== "object") throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  const permissionsInput = record(value.permissions, "plugin_manifest_invalid");
  exactKeys(permissionsInput, new Set(["capabilities"]), "plugin_manifest_invalid");
  if (!Array.isArray(permissionsInput.capabilities)) throw new WishPluginManifestError("plugin_manifest_invalid");
  const declared = permissionsInput.capabilities.map(item => {
    if (typeof item !== "string" || !capabilities.has(item)) throw new WishPluginManifestError("plugin_manifest_invalid");
    return item as WishPluginCapability;
  });
  if (new Set(declared).size !== declared.length) throw new WishPluginManifestError("plugin_manifest_invalid");
  const permissions = Object.freeze({ capabilities: Object.freeze(declared) });
  const sandboxInput = record(value.sandbox, "plugin_manifest_invalid");
  exactKeys(sandboxInput, new Set(["isolation", "filesystem", "process", "network"]), "plugin_manifest_invalid");
  if (sandboxInput.isolation !== "trusted-in-process" ||
    !["none", "capability-grant"].includes(sandboxInput.filesystem as string) ||
    !["none", "capability-grant"].includes(sandboxInput.process as string) ||
    !["none", "capability-grant"].includes(sandboxInput.network as string)) {
    throw new WishPluginManifestError("plugin_manifest_sandbox_unsupported");
  }
  const sandbox = Object.freeze({
    isolation: "trusted-in-process" as const,
    filesystem: sandboxInput.filesystem as "none" | "capability-grant",
    process: sandboxInput.process as "none" | "capability-grant",
    network: sandboxInput.network as "none" | "capability-grant",
  });
  requireSandboxCoverage(declared, sandbox);
  const state = parseState(value.state);
  return Object.freeze({
    apiVersion: WISH_PLUGIN_API_VERSION,
    id,
    ...(displayName === undefined ? {} : { displayName }),
    entry,
    managementClass: "managed" as const,
    replacement: value.replacement,
    configSchema,
    permissions,
    sandbox,
    state,
  });
}

/** Deterministic JSON-Schema subset used before importing or replacing code. */
export function assertWishPluginConfig(schema: WishPluginConfigSchema, input: unknown): void {
  validateValue(schema, input, 0);
}

function parseSchema(input: unknown, budget: { nodes: number }, depth: number): WishPluginConfigSchema {
  if (depth > 32 || ++budget.nodes > 1024) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  const value = record(input, "plugin_manifest_config_schema_invalid");
  exactKeys(value, schemaKeys, "plugin_manifest_config_schema_invalid");
  const type = value.type;
  if (!["null", "boolean", "integer", "number", "string", "array", "object"].includes(type as string)) {
    throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  }
  const output: Record<string, unknown> = { type };
  if (value.description !== undefined) output.description = text(value.description, "plugin_manifest_config_schema_invalid", 1000);
  if (value.const !== undefined) output.const = jsonValue(value.const, 0);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 256) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
    const values = value.enum.map(item => jsonValue(item, 0));
    if (new Set(values.map(item => JSON.stringify(item))).size !== values.length) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
    output.enum = Object.freeze(values);
  }
  for (const key of ["minimum", "maximum"] as const) if (value[key] !== undefined) output[key] = finite(value[key], "plugin_manifest_config_schema_invalid");
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) if (value[key] !== undefined) output[key] = natural(value[key], "plugin_manifest_config_schema_invalid");
  if ((value.minimum !== undefined || value.maximum !== undefined) && type !== "number" && type !== "integer") throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if ((value.minLength !== undefined || value.maxLength !== undefined) && type !== "string") throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if ((value.minItems !== undefined || value.maxItems !== undefined || value.items !== undefined) && type !== "array") throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if (value.items !== undefined) output.items = parseSchema(value.items, budget, depth + 1);
  if ((value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined) && type !== "object") {
    throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  }
  if (value.properties !== undefined) {
    const properties = record(value.properties, "plugin_manifest_config_schema_invalid");
    const parsed: Record<string, WishPluginConfigSchema> = {};
    for (const [key, child] of Object.entries(properties)) {
      if (!key || key.length > 200) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
      parsed[key] = parseSchema(child, budget, depth + 1);
    }
    output.properties = Object.freeze(parsed);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some(item => typeof item !== "string" || !item || item.length > 200) ||
      new Set(value.required).size !== value.required.length) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
    output.required = Object.freeze([...value.required] as string[]);
  }
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties === "boolean") output.additionalProperties = value.additionalProperties;
    else output.additionalProperties = parseSchema(value.additionalProperties, budget, depth + 1);
  }
  if (typeof output.minimum === "number" && typeof output.maximum === "number" && output.minimum > output.maximum) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if (typeof output.minLength === "number" && typeof output.maxLength === "number" && output.minLength > output.maxLength) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if (typeof output.minItems === "number" && typeof output.maxItems === "number" && output.minItems > output.maxItems) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  return Object.freeze(output) as unknown as WishPluginConfigSchema;
}

function validateValue(schema: WishPluginConfigSchema, input: unknown, depth: number): void {
  if (depth > 64) throw new WishPluginManifestError("plugin_config_invalid");
  if (schema.const !== undefined && JSON.stringify(input) !== JSON.stringify(schema.const)) throw new WishPluginManifestError("plugin_config_invalid");
  if (schema.enum !== undefined && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(input))) throw new WishPluginManifestError("plugin_config_invalid");
  switch (schema.type) {
    case "null": if (input !== null) throw new WishPluginManifestError("plugin_config_invalid"); break;
    case "boolean": if (typeof input !== "boolean") throw new WishPluginManifestError("plugin_config_invalid"); break;
    case "integer": if (typeof input !== "number" || !Number.isSafeInteger(input)) throw new WishPluginManifestError("plugin_config_invalid"); numeric(schema, input); break;
    case "number": if (typeof input !== "number" || !Number.isFinite(input)) throw new WishPluginManifestError("plugin_config_invalid"); numeric(schema, input); break;
    case "string":
      if (typeof input !== "string" || (schema.minLength !== undefined && input.length < schema.minLength) ||
        (schema.maxLength !== undefined && input.length > schema.maxLength)) throw new WishPluginManifestError("plugin_config_invalid");
      break;
    case "array":
      if (!Array.isArray(input) || (schema.minItems !== undefined && input.length < schema.minItems) ||
        (schema.maxItems !== undefined && input.length > schema.maxItems)) throw new WishPluginManifestError("plugin_config_invalid");
      if (schema.items) for (const item of input) validateValue(schema.items, item, depth + 1);
      break;
    case "object": {
      const value = record(input, "plugin_config_invalid");
      for (const key of schema.required ?? []) if (!(key in value)) throw new WishPluginManifestError("plugin_config_invalid");
      for (const [key, item] of Object.entries(value)) {
        const child = schema.properties?.[key];
        if (child) validateValue(child, item, depth + 1);
        else if (schema.additionalProperties === false) throw new WishPluginManifestError("plugin_config_invalid");
        else if (typeof schema.additionalProperties === "object") validateValue(schema.additionalProperties, item, depth + 1);
      }
      break;
    }
  }
}

function numeric(schema: WishPluginConfigSchema, input: number): void {
  if ((schema.minimum !== undefined && input < schema.minimum) || (schema.maximum !== undefined && input > schema.maximum)) {
    throw new WishPluginManifestError("plugin_config_invalid");
  }
}

function parseState(input: unknown): WishPluginState {
  const value = record(input, "plugin_manifest_invalid");
  if (value.mode === "stateless") {
    exactKeys(value, new Set(["mode"]), "plugin_manifest_invalid");
    return Object.freeze({ mode: "stateless" as const });
  }
  if (value.mode !== "versioned") throw new WishPluginManifestError("plugin_manifest_invalid");
  exactKeys(value, new Set(["mode", "schemaVersion", "readableVersions"]), "plugin_manifest_invalid");
  const schemaVersion = positive(value.schemaVersion, "plugin_manifest_invalid");
  if (!Array.isArray(value.readableVersions) || !value.readableVersions.length) throw new WishPluginManifestError("plugin_manifest_invalid");
  const readableVersions = value.readableVersions.map(item => positive(item, "plugin_manifest_invalid"));
  if (new Set(readableVersions).size !== readableVersions.length || !readableVersions.includes(schemaVersion)) throw new WishPluginManifestError("plugin_manifest_invalid");
  return Object.freeze({ mode: "versioned" as const, schemaVersion, readableVersions: Object.freeze(readableVersions) });
}

function requireSandboxCoverage(
  declared: readonly WishPluginCapability[],
  sandbox: WishPluginManifest["sandbox"],
): void {
  if (declared.some(item => item === "filesystem.read" || item === "filesystem.write") && sandbox.filesystem !== "capability-grant") {
    throw new WishPluginManifestError("plugin_manifest_sandbox_inconsistent");
  }
  if (declared.includes("process.exec") && sandbox.process !== "capability-grant") throw new WishPluginManifestError("plugin_manifest_sandbox_inconsistent");
  if (declared.some(item => item === "network.connect" || item === "web.search" || item === "web.fetch") && sandbox.network !== "capability-grant") {
    throw new WishPluginManifestError("plugin_manifest_sandbox_inconsistent");
  }
}

function resolveManifestFilename(reference: string, profileFilename: string): string {
  const value = text(reference, "plugin_manifest_invalid", 2048);
  let filename: string;
  try {
    const url = value.startsWith("file:") ? new URL(value) : pathToFileURL(isAbsolute(value) ? value : resolve(dirname(profileFilename), value));
    if (url.protocol !== "file:" || url.search || url.hash) throw new Error();
    filename = realpathSync(fileURLToPath(url));
  } catch { throw new WishPluginManifestError("plugin_manifest_unavailable"); }
  return filename;
}

function resolveEntry(specifier: string, baseFilename: string): string {
  try {
    let filename: string;
    if (specifier.startsWith("file:")) filename = fileURLToPath(new URL(specifier));
    else if (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier)) filename = resolve(dirname(baseFilename), specifier);
    else filename = createRequire(pathToFileURL(baseFilename)).resolve(specifier);
    return realpathSync(filename);
  } catch { throw new WishPluginManifestError("plugin_manifest_entry_unavailable"); }
}

function jsonValue(input: unknown, depth: number): JsonValue {
  if (depth > 32) throw new WishPluginManifestError("plugin_manifest_config_schema_invalid");
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return Object.freeze(input.map(item => jsonValue(item, depth + 1)));
  const value = record(input, "plugin_manifest_config_schema_invalid"), result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, depth + 1);
  return Object.freeze(result);
}

function record(input: unknown, code: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new WishPluginManifestError(code);
  return input as Record<string, unknown>;
}
function exactKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, code: string): void {
  if (Object.keys(input).some(key => !allowed.has(key))) throw new WishPluginManifestError(code);
}
function text(input: unknown, code: string, maximum: number): string {
  if (typeof input !== "string" || !input || input !== input.trim() || input.length > maximum || /[\u0000-\u001f]/u.test(input)) throw new WishPluginManifestError(code);
  return input;
}
function identifier(input: unknown, code: string): string {
  const value = text(input, code, 100);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) throw new WishPluginManifestError(code);
  return value;
}
function finite(input: unknown, code: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) throw new WishPluginManifestError(code);
  return input;
}
function natural(input: unknown, code: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw new WishPluginManifestError(code);
  return input;
}
function positive(input: unknown, code: string): number {
  const value = natural(input, code);
  if (!value) throw new WishPluginManifestError(code);
  return value;
}
