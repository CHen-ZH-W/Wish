import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ContextInstruction } from "../context/types.js";
import {
  loadModelsConfiguration,
  loadModelsConfigurationFile,
  resolveConfiguredModel,
} from "../models/config.js";
import type {
  ModelEnvironment,
  ModelsConfiguration,
} from "../models/types.js";

const DEFAULT_AGENT_ID = "wish";
const DEFAULT_AGENT_INSTRUCTION =
  "You are Wish, a coding agent. Work carefully within the provided workspace and report results truthfully.";
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_192;
const DEFAULT_KEEP_RECENT_TOKENS = 16_384;
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4_096;

export class WishHostConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WishHostConfigurationError";
  }
}

/** Resolved settings consumed while opening one Application generation. */
export interface WishHostConfiguration {
  readonly dataDirectory: string;
  readonly agentId: string;
  readonly agentInstructions: readonly ContextInstruction[];
  readonly models: ModelsConfiguration;
  /** Read only while resolving Provider credentials and environment headers. */
  readonly modelEnvironment: ModelEnvironment;
  readonly reservedOutputTokens: number;
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
}

export interface LoadWishHostConfigurationInput {
  readonly dataDirectory?: string;
  readonly homeDirectory?: string;
  readonly modelsConfigurationPath?: string;
  readonly modelsConfigurationJson?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly modelMaxRetries?: number;
  /** Pre-resolved by the Cordis Models service in product compositions. */
  readonly resolvedModels?: ModelsConfiguration;
  /** Provider credentials and environment-backed request headers only. */
  readonly environment?: ModelEnvironment;
  readonly agentId?: string;
  readonly agentInstructions?: readonly ContextInstruction[];
  readonly reservedOutputTokens?: number;
  readonly keepRecentTokens?: number;
  readonly summaryMaxOutputTokens?: number;
}

/** Resolve process-level configuration without introducing another Models format. */
export async function loadWishHostConfiguration(
  input: LoadWishHostConfigurationInput = {},
): Promise<WishHostConfiguration> {
  const environment = input.environment ?? process.env;
  const dataDirectory = normalizeDirectory(
    input.dataDirectory ?? join(
      input.homeDirectory ?? homedir(),
      ".wish",
    ),
    "Wish data directory",
  );
  const configurationPath = input.modelsConfigurationPath;
  const modelsEnvironment: ModelEnvironment = Object.freeze({
    ...(input.modelsConfigurationJson === undefined
      ? {}
      : { WISH_MODELS_JSON: input.modelsConfigurationJson }),
    ...(input.model === undefined ? {} : { WISH_MODEL: input.model }),
    ...(input.fallbackModels === undefined
      ? {}
      : { WISH_FALLBACK_MODELS: input.fallbackModels.join(",") }),
    ...(input.modelMaxRetries === undefined
      ? {}
      : { WISH_MODEL_MAX_RETRIES: String(input.modelMaxRetries) }),
  });
  const defaultConfigurationPath = join(dataDirectory, "models.json");
  const models = input.resolvedModels ?? (configurationPath !== undefined
    ? await loadModelsConfigurationFile({
        path: resolve(configurationPath),
        environment: modelsEnvironment,
      })
    : input.modelsConfigurationJson !== undefined
      ? loadModelsConfiguration({ environment: modelsEnvironment })
      : await fileExists(defaultConfigurationPath)
        ? await loadModelsConfigurationFile({
            path: defaultConfigurationPath,
            environment: modelsEnvironment,
          })
        : loadModelsConfiguration({ environment: modelsEnvironment }));
  const selected = resolveConfiguredModel(models, models.defaultModel).spec;
  const contextWindowTokens = selected.contextWindowTokens;
  const defaultReserved = contextWindowTokens === undefined
    ? Math.max(1, Math.min(
        selected.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
        DEFAULT_RESERVED_OUTPUT_TOKENS,
      ))
    : Math.min(
        selected.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
        Math.floor(contextWindowTokens / 4),
        Math.max(0, contextWindowTokens - 1),
      );
  const reservedOutputTokens = readNonNegativeInteger({
    explicit: input.reservedOutputTokens,
    fallback: defaultReserved,
    name: "reservedOutputTokens",
  });
  if (
    contextWindowTokens !== undefined &&
    reservedOutputTokens >= contextWindowTokens
  ) {
    throw new WishHostConfigurationError(
      "reservedOutputTokens must be less than the default model context window",
    );
  }
  const availableInputTokens = contextWindowTokens === undefined
    ? undefined
    : Math.max(1, contextWindowTokens - reservedOutputTokens);
  const keepRecentTokens = readPositiveInteger({
    explicit: input.keepRecentTokens,
    fallback: availableInputTokens === undefined
      ? DEFAULT_KEEP_RECENT_TOKENS
      : Math.max(1, Math.min(
          DEFAULT_KEEP_RECENT_TOKENS,
          Math.floor(availableInputTokens / 2),
        )),
    name: "keepRecentTokens",
  });
  const summaryMaxOutputTokens = readPositiveInteger({
    explicit: input.summaryMaxOutputTokens,
    fallback: Math.max(1, Math.min(
      selected.maxOutputTokens ?? DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
    )),
    name: "summaryMaxOutputTokens",
  });
  const agentId = requireIdentifier(
    input.agentId ?? DEFAULT_AGENT_ID,
    "Wish Agent id",
  );
  const agentInstructions = snapshotInstructions(
    input.agentInstructions ?? defaultInstructions(),
  );

  return Object.freeze({
    dataDirectory,
    agentId,
    agentInstructions,
    models,
    modelEnvironment: environment,
    reservedOutputTokens,
    keepRecentTokens,
    summaryMaxOutputTokens,
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (
      error !== null && typeof error === "object" && "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) return false;
    throw new WishHostConfigurationError(
      `Wish models configuration path cannot be inspected: ${path}`,
    );
  }
}

function defaultInstructions(): readonly ContextInstruction[] {
  return Object.freeze([Object.freeze({
    id: "wish-agent-base",
    authority: "system" as const,
    content: DEFAULT_AGENT_INSTRUCTION,
  })]);
}

function snapshotInstructions(
  instructions: readonly ContextInstruction[],
): readonly ContextInstruction[] {
  if (!Array.isArray(instructions)) {
    throw new WishHostConfigurationError("Agent instructions must be an array");
  }
  return Object.freeze(instructions.map((instruction, index) => {
    if (instruction === null || typeof instruction !== "object") {
      throw new WishHostConfigurationError(
        `Agent instruction ${index + 1} must be an object`,
      );
    }
    if (instruction.authority !== "system" && instruction.authority !== "developer") {
      throw new WishHostConfigurationError(
        `Agent instruction ${index + 1} has an invalid authority`,
      );
    }
    return Object.freeze({
      id: requireIdentifier(
        instruction.id,
        `Agent instruction ${index + 1} id`,
      ),
      authority: instruction.authority,
      content: requireText(
        instruction.content,
        `Agent instruction ${index + 1} content`,
      ),
    });
  }));
}

function readNonNegativeInteger(input: {
  readonly explicit: number | undefined;
  readonly fallback: number;
  readonly name: string;
}): number {
  const value = input.explicit ?? input.fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WishHostConfigurationError(
      `${input.name} must be a non-negative safe integer`,
    );
  }
  return value;
}

function readPositiveInteger(input: {
  readonly explicit: number | undefined;
  readonly fallback: number;
  readonly name: string;
}): number {
  const value = readNonNegativeInteger(input);
  if (value < 1) {
    throw new WishHostConfigurationError(
      `${input.name} must be a positive safe integer`,
    );
  }
  return value;
}

function normalizeDirectory(value: string, label: string): string {
  return resolve(requireText(value, label));
}

function requireIdentifier(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)) {
    throw new WishHostConfigurationError(`${label} must be a valid identifier`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new WishHostConfigurationError(
      `${label} must be a non-empty trimmed string`,
    );
  }
  return value;
}
