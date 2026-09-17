import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { formatModelReference } from "../models/config.js";
import type { ModelsConfiguration } from "../models/types.js";
import type { SubagentResult, SubagentResultReader } from "./types.js";
import type { SubagentLaunchIdentity, SubagentOwner } from "./types.js";
import { assertResourceIdentity, createResourceManifest, resourceType, snapshotResourceManifest, type SubagentResource, type SubagentResourceManifest } from "./resources.js";
import { readResourceFile, removeResourceFile, writeResourceFile } from "./resource-files.js";

interface StoredSubagentResult {
  readonly schemaVersion: 1;
  readonly type: "wish_subagent_result";
  readonly result: SubagentResult;
}

export class FileSubagentExchange implements SubagentResultReader {
  readonly dataDirectory: string;
  readonly rootDirectory: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(requireText(dataDirectory, "Subagent data directory"));
    this.rootDirectory = join(this.dataDirectory, "subagents");
  }

  async createTask(id: string, task: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const path = this.taskPath(id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, requireTask(task), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      throwIfAborted(signal);
      return path;
    } catch (error: unknown) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async consumeTask(path: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const resolved = resolve(path);
    if (dirname(resolved) !== join(this.rootDirectory, "tasks")) {
      throw new Error("Subagent task file is outside the exchange directory");
    }
    const task = requireTask(await readFile(resolved, "utf8"));
    throwIfAborted(signal);
    await unlink(resolved);
    return task;
  }

  async removeTask(id: string): Promise<void> {
    await unlink(this.taskPath(id)).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }

  resultPath(id: string): string {
    return join(this.rootDirectory, "results", `${key(id)}.json`);
  }

  childDataDirectory(id: string): string {
    return join(this.rootDirectory, "children", key(id));
  }

  inputResourcesPath(id: string): string {
    return join(this.childDataDirectory(id), "resources", "input.json");
  }

  async writeInputResources(identity: SubagentLaunchIdentity, owner: SubagentOwner, resources: readonly SubagentResource[], signal?: AbortSignal): Promise<SubagentResourceManifest> {
    const manifest = createResourceManifest(identity, owner, resources);
    await writeResourceFile(this.inputResourcesPath(identity.id), manifest, false, signal);
    return manifest;
  }

  async readInputResources(identity: SubagentLaunchIdentity, signal?: AbortSignal): Promise<SubagentResourceManifest | undefined> {
    const value = await readResourceFile(this.inputResourcesPath(identity.id), signal);
    if (value === undefined) return undefined;
    const manifest = snapshotResourceManifest(value);
    assertResourceIdentity(manifest, identity);
    return manifest;
  }

  async removeInputResources(id: string): Promise<void> {
    await removeResourceFile(this.inputResourcesPath(id));
  }

  async writeOutputResource(input: SubagentResourceManifest, resource: SubagentResource, signal?: AbortSignal): Promise<void> {
    const manifest = createResourceManifest(input.identity, input.owner, [resource]);
    await writeResourceFile(this.outputResourcePath(input.identity.id, resource.type), { inputDigest: input.digest, manifest }, true, signal);
  }

  async readOutputResource(input: SubagentResourceManifest, type: string, signal?: AbortSignal): Promise<SubagentResource | undefined> {
    const value = await readResourceFile(this.outputResourcePath(input.identity.id, type), signal) as { inputDigest?: unknown; manifest?: unknown } | undefined;
    if (value === undefined) return undefined;
    if (!value || value.inputDigest !== input.digest) throw new Error("Subagent output resource belongs to another input snapshot");
    const output = snapshotResourceManifest(value.manifest);
    assertResourceIdentity(output, input.identity);
    if (JSON.stringify(output.owner) !== JSON.stringify(input.owner) || output.resources.length !== 1 || output.resources[0]?.type !== type) throw new Error("Subagent output resource scope mismatch");
    return output.resources[0];
  }

  private outputResourcePath(id: string, type: string): string {
    return join(this.childDataDirectory(id), "resources", "output", `${resourceType(type)}.json`);
  }

  async writeModelsConfiguration(
    id: string,
    configuration: ModelsConfiguration,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const path = join(this.childDataDirectory(id), "models.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      providers: configuration.providers,
      defaultModel: formatModelReference(configuration.defaultModel),
      fallbackModels: configuration.fallbackModels.map(formatModelReference),
      maxRetries: configuration.maxRetries,
    })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      throwIfAborted(signal);
      return path;
    } catch (error: unknown) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async removeModelsConfiguration(id: string): Promise<void> {
    await unlink(join(this.childDataDirectory(id), "models.json")).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }

  async writeResult(result: SubagentResult, signal?: AbortSignal): Promise<void> {
    const stable = snapshotResult(result);
    throwIfAborted(signal);
    const target = this.resultPath(stable.id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify({
        schemaVersion: 1,
        type: "wish_subagent_result",
        result: stable,
      } satisfies StoredSubagentResult)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      throwIfAborted(signal);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async read(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    throwIfAborted(signal);
    let text: string;
    try {
      text = await readFile(this.resultPath(id), "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    throwIfAborted(signal);
    const parsed = JSON.parse(text) as Partial<StoredSubagentResult>;
    if (parsed.schemaVersion !== 1 || parsed.type !== "wish_subagent_result") {
      throw new Error("Subagent result envelope is invalid");
    }
    return snapshotResult(parsed.result);
  }

  private taskPath(id: string): string {
    return join(this.rootDirectory, "tasks", `${key(id)}.txt`);
  }
}

export function snapshotResult(value: unknown): SubagentResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Subagent result is invalid");
  }
  const result = value as Partial<SubagentResult>;
  if (
    result.schemaVersion !== 1 ||
    (result.status !== "completed" && result.status !== "failed" && result.status !== "aborted")
  ) throw new TypeError("Subagent result shape is invalid");
  const completedAt = requireText(result.completedAt, "Subagent result completedAt");
  if (!Number.isFinite(Date.parse(completedAt))) {
    throw new TypeError("Subagent result completedAt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    id: requireText(result.id, "Subagent result id"),
    childSessionId: requireText(result.childSessionId, "Subagent result Session id"),
    childRunId: requireText(result.childRunId, "Subagent result Run id"),
    status: result.status,
    ...(result.text === undefined
      ? {}
      : { text: requireString(result.text, "Subagent result text") }),
    ...(result.error === undefined ? {} : { error: requireText(result.error, "Subagent result error") }),
    completedAt,
  });
}

function key(id: string): string {
  return createHash("sha256").update(requireText(id, "Subagent id")).digest("hex");
}

function requireTask(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Subagent task must not be empty");
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
