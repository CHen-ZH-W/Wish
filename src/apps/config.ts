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
import type {
  BasicToolContext,
  ToolApprovalPort,
} from "../tools/index.js";
import {
  createWishApplication,
  type WishApplicationOptions,
} from "./application.js";
import type { WishApplication } from "./types.js";

const DEFAULT_AGENT_ID = "wish";
const DEFAULT_AGENT_INSTRUCTION =
  "You are Wish, a coding agent. Work carefully within the provided workspace and report results truthfully.";
const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_192;
const DEFAULT_KEEP_RECENT_TOKENS = 16_384;
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_MAX_STEPS = 32;

export class WishHostConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WishHostConfigurationError";
  }
}

/** Host-owned settings shared by the CLI and the later WebUI server. */
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
  readonly maxSteps: number;
}

export interface LoadWishHostConfigurationInput {
  readonly dataDirectory?: string;
  readonly homeDirectory?: string;
  readonly modelsConfigurationPath?: string;
  readonly environment?: ModelEnvironment;
  readonly agentId?: string;
  readonly agentInstructions?: readonly ContextInstruction[];
  readonly reservedOutputTokens?: number;
  readonly keepRecentTokens?: number;
  readonly summaryMaxOutputTokens?: number;
  readonly maxSteps?: number;
}

export interface CreateWishHostApplicationInput {
  readonly approval?: ToolApprovalPort<BasicToolContext>;
}

/** Resolve process-level configuration without introducing another Models format. */
export async function loadWishHostConfiguration(
  input: LoadWishHostConfigurationInput = {},
): Promise<WishHostConfiguration> {
  const environment = input.environment ?? process.env;
  const dataDirectory = normalizeDirectory(
    input.dataDirectory ?? environment.WISH_DATA_DIR ?? join(
      input.homeDirectory ?? homedir(),
      ".wish",
    ),
    "Wish data directory",
  );
  const configurationPath = input.modelsConfigurationPath ??
    environment.WISH_MODELS_CONFIG;
  const defaultConfigurationPath = join(dataDirectory, "models.json");
  const models = configurationPath !== undefined
    ? await loadModelsConfigurationFile({
        path: resolve(configurationPath),
        environment,
      })
    : environment.WISH_MODELS_JSON !== undefined
      ? loadModelsConfiguration({ environment })
      : await fileExists(defaultConfigurationPath)
        ? await loadModelsConfigurationFile({
            path: defaultConfigurationPath,
            environment,
          })
        : loadModelsConfiguration({ environment });
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
    environment: environment.WISH_CONTEXT_RESERVED_OUTPUT_TOKENS,
    fallback: defaultReserved,
    name: "reservedOutputTokens",
    environmentName: "WISH_CONTEXT_RESERVED_OUTPUT_TOKENS",
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
    environment: environment.WISH_COMPACTION_KEEP_RECENT_TOKENS,
    fallback: availableInputTokens === undefined
      ? DEFAULT_KEEP_RECENT_TOKENS
      : Math.max(1, Math.min(
          DEFAULT_KEEP_RECENT_TOKENS,
          Math.floor(availableInputTokens / 2),
        )),
    name: "keepRecentTokens",
    environmentName: "WISH_COMPACTION_KEEP_RECENT_TOKENS",
  });
  const summaryMaxOutputTokens = readPositiveInteger({
    explicit: input.summaryMaxOutputTokens,
    environment: environment.WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS,
    fallback: Math.max(1, Math.min(
      selected.maxOutputTokens ?? DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
    )),
    name: "summaryMaxOutputTokens",
    environmentName: "WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS",
  });
  const maxSteps = readPositiveInteger({
    explicit: input.maxSteps,
    environment: environment.WISH_MAX_STEPS,
    fallback: DEFAULT_MAX_STEPS,
    name: "maxSteps",
    environmentName: "WISH_MAX_STEPS",
  });
  const agentId = requireIdentifier(
    input.agentId ?? environment.WISH_AGENT_ID ?? DEFAULT_AGENT_ID,
    "Wish Agent id",
  );
  const agentInstructions = snapshotInstructions(
    input.agentInstructions ?? instructionsFromEnvironment(environment),
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
    maxSteps,
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

/** Instantiate the shared composition root from one resolved host configuration. */
export function createWishHostApplication(
  configuration: WishHostConfiguration,
  input: CreateWishHostApplicationInput = {},
): WishApplication {
  const options: WishApplicationOptions = {
    dataDirectory: configuration.dataDirectory,
    agent: {
      id: configuration.agentId,
      name: "Wish",
      configuration: {
        agentInstructions: configuration.agentInstructions,
      },
    },
    models: {
      configuration: configuration.models,
      environment: configuration.modelEnvironment,
    },
    workspace: {
      resolve({ session }) {
        return Object.freeze({
          cwd: session.scope,
          instructions: Object.freeze([]),
        });
      },
    },
    context: {
      reservedOutputTokens: configuration.reservedOutputTokens,
    },
    compaction: {
      keepRecentTokens: configuration.keepRecentTokens,
      summaryMaxOutputTokens: configuration.summaryMaxOutputTokens,
    },
    runtime: {
      maxSteps: configuration.maxSteps,
    },
    ...(input.approval === undefined
      ? {}
      : { tools: { approval: input.approval } }),
  };
  return createWishApplication(options);
}

function instructionsFromEnvironment(
  environment: ModelEnvironment,
): readonly ContextInstruction[] {
  const configured = environment.WISH_AGENT_INSTRUCTIONS;
  const content = configured === undefined
    ? DEFAULT_AGENT_INSTRUCTION
    : requireText(configured, "WISH_AGENT_INSTRUCTIONS");
  return Object.freeze([Object.freeze({
    id: "wish-agent-base",
    authority: "system" as const,
    content,
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
  readonly environment: string | undefined;
  readonly fallback: number;
  readonly name: string;
  readonly environmentName: string;
}): number {
  const value = input.explicit ?? parseEnvironmentInteger(
    input.environment,
    input.environmentName,
  ) ?? input.fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WishHostConfigurationError(
      `${input.name} must be a non-negative safe integer`,
    );
  }
  return value;
}

function readPositiveInteger(input: {
  readonly explicit: number | undefined;
  readonly environment: string | undefined;
  readonly fallback: number;
  readonly name: string;
  readonly environmentName: string;
}): number {
  const value = readNonNegativeInteger(input);
  if (value < 1) {
    throw new WishHostConfigurationError(
      `${input.name} must be a positive safe integer`,
    );
  }
  return value;
}

function parseEnvironmentInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new WishHostConfigurationError(
      `${name} must be a non-negative integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WishHostConfigurationError(
      `${name} must be a non-negative safe integer`,
    );
  }
  return parsed;
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
