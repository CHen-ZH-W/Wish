import type {
  AgentLoopContextEnvironment,
  AgentLoopRequestView,
  AgentLoopToolResultRenderer,
} from "../core/agent-loop/agent-loop.js";
import {
  ContextProjector,
  type ContextProvider,
} from "../core/context/projector.js";
import type { ModelRef } from "../core/model/model.js";
import type { StepSnapshot } from "../core/runtime/runtime.js";
import type { ToolResultArchivePort } from "../tools/results/types.js";
import { HistoryContextProvider } from "./providers/history.js";
import { InstructionsContextProvider } from "./providers/instructions.js";
import { StateContextProvider } from "./providers/state.js";
import { ObservedContextProjector, type ContextObservationListener } from "./observation.js";
import { ModelContextBudgetEvaluator } from "./services/budget.js";
import { LatestCheckpointHistoryPolicy } from "./services/history-policy.js";
import {
  ContextToolResultAdmissionPipeline,
  createArchivingToolResultRenderer,
  type ToolResultArchiveSessionInput,
} from "./services/tool-results.js";
import {
  DEFAULT_CONTEXT_TOOL_RESULT_ADMISSION,
  type ContextConfiguration,
  type ContextHistorySource,
  type ContextInput,
  type ContextProviderId,
  type ContextSessionId,
  type ContextToolResultAdmissionConfiguration,
  type ContextWorkspaceFacts,
  type ModelContextWindowSource,
  type ModelInputTokenCounter,
} from "./types.js";

export const DEFAULT_CONTEXT_PROVIDER_ORDER = Object.freeze([
  "instructions",
  "history",
  "state",
]) satisfies readonly ContextProviderId[];

export interface ContextBundleConfigurationInput {
  readonly reservedOutputTokens: number;
  readonly toolResultAdmission?: ContextToolResultAdmissionConfiguration;
  /** Must name every built-in and additional Provider exactly once. */
  readonly providerOrder?: readonly ContextProviderId[];
}

export interface ContextBundleOptions {
  readonly observe?: ContextObservationListener;
  readonly history: ContextHistorySource;
  readonly archive: ToolResultArchivePort;
  readonly models: ModelContextWindowSource;
  readonly counter: ModelInputTokenCounter;
  readonly configuration: ContextBundleConfigurationInput;
  /** Future Context sources register through the existing Core Provider Port. */
  readonly additionalProviders?: readonly ContextProvider<ContextInput>[];
  /** Host-owned live registry, snapshotted once when preparing each Step. */
  readonly additionalProviderSource?: () => readonly ContextProvider<ContextInput>[];
}

export interface ContextStepInput<Payload = unknown> {
  readonly snapshot: StepSnapshot<Payload>;
  readonly sessionId: ContextSessionId;
  readonly model: ModelRef;
  /** Resolved outside Context for this exact Step. */
  readonly workspace: ContextWorkspaceFacts;
}

export interface ContextBundleToolResultRendererOptions<Payload = unknown> {
  readonly delegate: AgentLoopToolResultRenderer<Payload>;
  readonly resolveSessionId: (
    input: ToolResultArchiveSessionInput<Payload>,
  ) => ContextSessionId;
}

export interface ContextBundle {
  readonly configuration: ContextConfiguration;
  readonly projector: ContextProjector;
  readonly providers: readonly ContextProvider<ContextInput>[];
  readonly historyPolicy: LatestCheckpointHistoryPolicy;
  readonly toolResults: ContextToolResultAdmissionPipeline;
  readonly budget: ModelContextBudgetEvaluator;

  /** Exact value for AgentLoopStepEnvironment.context. */
  forStep<Payload = unknown>(
    input: ContextStepInput<Payload>,
  ): AgentLoopContextEnvironment<ContextInput>;

  /** Archive-first renderer for AgentLoopOptions.toolResults. */
  createToolResultRenderer<Payload = unknown>(
    options: ContextBundleToolResultRendererOptions<Payload>,
  ): AgentLoopToolResultRenderer<Payload>;
}

/** Builds the complete Context side of an AgentLoop composition. */
export function createContextBundle(options: ContextBundleOptions): ContextBundle {
  const historyPolicy = new LatestCheckpointHistoryPolicy();
  const toolResults = new ContextToolResultAdmissionPipeline(
    options.configuration.toolResultAdmission ??
      DEFAULT_CONTEXT_TOOL_RESULT_ADMISSION,
  );
  const budget = new ModelContextBudgetEvaluator({
    models: options.models,
    counter: options.counter,
    reservedOutputTokens: options.configuration.reservedOutputTokens,
  });
  const fixedProviders: readonly ContextProvider<ContextInput>[] = [
    new InstructionsContextProvider(),
    new HistoryContextProvider({ source: options.history }),
    new StateContextProvider(),
    ...snapshotAdditionalProviders(options.additionalProviders),
  ];
  const currentProviders = () => orderProviders([
    ...fixedProviders,
    ...snapshotAdditionalProviders(options.additionalProviderSource?.()),
  ], options.configuration.providerOrder);
  // Keep eager validation for standalone composition and the initial Host graph.
  currentProviders();
  const stepProviders = new WeakMap<object, readonly ContextProvider<ContextInput>[]>();
  const projector = new ObservedContextProjector({
    historyPolicy,
    toolResults,
    budget,
  }, options.observe);

  const bundle: ContextBundle = {
    get configuration(): ContextConfiguration {
      return Object.freeze({
        reservedOutputTokens: budget.reservedOutputTokens,
        toolResultAdmission: toolResults.configuration,
        providerOrder: Object.freeze(currentProviders().map(provider => provider.id)),
      });
    },
    projector,
    get providers() { return currentProviders(); },
    historyPolicy,
    toolResults,
    budget,
    forStep<Payload>(input: ContextStepInput<Payload>) {
      let providers = stepProviders.get(input.snapshot);
      if (!providers) {
        providers = currentProviders();
        stepProviders.set(input.snapshot, providers);
      }
      return Object.freeze({
        providers,
        input: createContextInput(input),
        projectInput({ input: base, request }: {
          readonly input: ContextInput;
          readonly request: AgentLoopRequestView;
        }): ContextInput {
          return Object.freeze({ ...base, request });
        },
      });
    },
    createToolResultRenderer<Payload>(
      rendererOptions: ContextBundleToolResultRendererOptions<Payload>,
    ) {
      return createArchivingToolResultRenderer({
        archive: options.archive,
        delegate: rendererOptions.delegate,
        resolveSessionId: rendererOptions.resolveSessionId,
      });
    },
  };
  return Object.freeze(bundle);
}

/** Deterministically maps one immutable Runtime snapshot plus resolved facts. */
export function createContextInput<Payload = unknown>(
  input: ContextStepInput<Payload>,
): ContextInput {
  const snapshot = input.snapshot;
  if (snapshot === null || typeof snapshot !== "object") {
    throw new Error("Context Step snapshot must be an object");
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error("Unknown Context Step snapshot schemaVersion");
  }
  if (
    snapshot.run === null || typeof snapshot.run !== "object" ||
    snapshot.userTurn === null || typeof snapshot.userTurn !== "object" ||
    snapshot.step === null || typeof snapshot.step !== "object"
  ) {
    throw new Error("Context Step snapshot has an invalid hierarchy");
  }
  return Object.freeze({
    runId: requireIdentifier(snapshot.run.runId, "Context runId"),
    userTurnId: requireIdentifier(
      snapshot.userTurn.userTurnId,
      "Context userTurnId",
    ),
    stepId: requireIdentifier(snapshot.step.stepId, "Context stepId"),
    sessionId: requireIdentifier(input.sessionId, "Context sessionId"),
    model: freezeModelRef(input.model),
    workspace: snapshotWorkspace(input.workspace),
    runtime: Object.freeze({
      capturedAt: requireIdentifier(
        snapshot.capturedAt,
        "Context capturedAt",
      ),
      stateVersion: nonNegativeSafeInteger(
        snapshot.stateVersion,
        "Context stateVersion",
      ),
      userTurnOrdinal: positiveSafeInteger(
        snapshot.userTurn.ordinal,
        "Context userTurnOrdinal",
      ),
      stepOrdinal: positiveSafeInteger(
        snapshot.step.ordinal,
        "Context stepOrdinal",
      ),
    }),
  });
}

function orderProviders(
  providers: readonly ContextProvider<ContextInput>[],
  requestedOrder: readonly ContextProviderId[] | undefined,
): readonly ContextProvider<ContextInput>[] {
  const byId = new Map<string, ContextProvider<ContextInput>>();
  for (const provider of providers) {
    if (provider === null || typeof provider !== "object") {
      throw new Error("Context bundle Providers must be objects");
    }
    const id = requireIdentifier(provider.id, "Context Provider id");
    if (byId.has(id)) {
      throw new Error(`Duplicate Context Provider id: ${id}`);
    }
    byId.set(id, provider);
  }
  const order = requestedOrder === undefined
    ? [
      ...DEFAULT_CONTEXT_PROVIDER_ORDER,
      ...providers
        .map((provider) => provider.id)
        .filter((id) => !DEFAULT_CONTEXT_PROVIDER_ORDER.includes(id)),
    ]
    : [...requestedOrder];
  if (order.length !== byId.size) {
    throw new Error("Context providerOrder must name every Provider exactly once");
  }
  const seen = new Set<string>();
  const ordered = order.map((rawId) => {
    const id = requireIdentifier(rawId, "Context providerOrder id");
    if (seen.has(id)) {
      throw new Error(`Duplicate Context providerOrder id: ${id}`);
    }
    seen.add(id);
    const provider = byId.get(id);
    if (provider === undefined) {
      throw new Error(`Unknown Context providerOrder id: ${id}`);
    }
    return provider;
  });
  return Object.freeze(ordered);
}

function snapshotAdditionalProviders(
  providers: readonly ContextProvider<ContextInput>[] | undefined,
): readonly ContextProvider<ContextInput>[] {
  if (providers === undefined) return Object.freeze([]);
  if (!Array.isArray(providers)) {
    throw new Error("Context additionalProviders must be an array");
  }
  return Object.freeze([...providers]);
}

function snapshotWorkspace(workspace: ContextWorkspaceFacts): ContextWorkspaceFacts {
  if (workspace === null || typeof workspace !== "object") {
    throw new Error("Context workspace facts must be an object");
  }
  if (!Array.isArray(workspace.instructions)) {
    throw new Error("Context workspace instructions must be an array");
  }
  const ids = new Set<string>();
  const instructions = workspace.instructions.map((instruction) => {
    if (instruction === null || typeof instruction !== "object") {
      throw new Error("Context workspace instructions must contain objects");
    }
    const id = requireIdentifier(instruction.id, "Context instruction id");
    if (ids.has(id)) {
      throw new Error(`Duplicate Context workspace instruction id: ${id}`);
    }
    ids.add(id);
    if (
      instruction.authority !== "system" &&
      instruction.authority !== "developer"
    ) {
      throw new Error("Context instruction authority must be system or developer");
    }
    if (
      typeof instruction.content !== "string" ||
      instruction.content.trim().length === 0
    ) {
      throw new Error("Context instruction content must be a non-empty string");
    }
    return Object.freeze({
      id,
      authority: instruction.authority,
      content: instruction.content,
    });
  });
  return Object.freeze({
    cwd: requireIdentifier(workspace.cwd, "Context cwd"),
    fingerprint: requireIdentifier(
      workspace.fingerprint,
      "Context workspace fingerprint",
    ),
    revision: requireIdentifier(
      workspace.revision,
      "Context workspace revision",
    ),
    instructions: Object.freeze(instructions),
    ...(workspace.repository === undefined
      ? {}
      : { repository: snapshotWorkspaceRepository(workspace.repository) }),
  });
}

function snapshotWorkspaceRepository(
  repository: NonNullable<ContextWorkspaceFacts["repository"]>,
): NonNullable<ContextWorkspaceFacts["repository"]> {
  if (repository === null || typeof repository !== "object") {
    throw new Error("Context workspace repository must be an object");
  }
  if (repository.kind !== "git") {
    throw new Error("Context workspace repository kind must be git");
  }
  return Object.freeze({
    kind: "git" as const,
    root: requireIdentifier(
      repository.root,
      "Context workspace repository root",
    ),
    identity: requireIdentifier(
      repository.identity,
      "Context workspace repository identity",
    ),
  });
}

function freezeModelRef(model: ModelRef): ModelRef {
  if (model === null || typeof model !== "object") {
    throw new Error("Context model reference must be an object");
  }
  return Object.freeze({
    provider: requireIdentifier(model.provider, "Context Model Provider id"),
    model: requireIdentifier(model.model, "Context Model id"),
  });
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}
