import type {
  ContextItem,
  ContextProvider,
} from "../../core/context/projector.js";
import type { ContextInput } from "../types.js";

const DEFAULT_PROVIDER_ID = "state";

/** Renders a new trusted state item from every immutable Step input. */
export class StateContextProvider implements ContextProvider<ContextInput> {
  readonly id: string;
  private readonly itemId: string;

  constructor(id = DEFAULT_PROVIDER_ID) {
    this.id = requireIdentifier(id, "State provider id");
    this.itemId = `${encodeURIComponent(this.id)}:current-step`;
  }

  provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): readonly ContextItem[] {
    throwIfAborted(signal);
    const state = Object.freeze({
      cwd: requireIdentifier(input.workspace.cwd, "Context cwd"),
      workspace: Object.freeze({
        fingerprint: requireIdentifier(
          input.workspace.fingerprint,
          "Context workspace fingerprint",
        ),
        revision: requireIdentifier(
          input.workspace.revision,
          "Context workspace revision",
        ),
        ...(input.workspace.repository === undefined
          ? {}
          : {
            repository: Object.freeze({
              kind: input.workspace.repository.kind,
              root: requireIdentifier(
                input.workspace.repository.root,
                "Context workspace repository root",
              ),
              identity: requireIdentifier(
                input.workspace.repository.identity,
                "Context workspace repository identity",
              ),
            }),
          }),
      }),
      capturedAt: requireIdentifier(
        input.runtime.capturedAt,
        "Context capturedAt",
      ),
      run: Object.freeze({
        id: requireIdentifier(input.runId, "Context runId"),
        stateVersion: nonNegativeSafeInteger(
          input.runtime.stateVersion,
          "Context stateVersion",
        ),
      }),
      userTurn: Object.freeze({
        id: requireIdentifier(input.userTurnId, "Context userTurnId"),
        ordinal: positiveSafeInteger(
          input.runtime.userTurnOrdinal,
          "Context userTurnOrdinal",
        ),
      }),
      step: Object.freeze({
        id: requireIdentifier(input.stepId, "Context stepId"),
        ordinal: positiveSafeInteger(
          input.runtime.stepOrdinal,
          "Context stepOrdinal",
        ),
      }),
    });
    const content = [
      "Current execution state for this Step follows. Prefer it over stale history:",
      JSON.stringify(state, null, 2),
    ].join("\n");
    throwIfAborted(signal);
    return Object.freeze([
      Object.freeze({
        id: this.itemId,
        kind: "state" as const,
        placement: "dynamic_tail" as const,
        message: Object.freeze({
          role: "developer" as const,
          content,
        }),
      }),
    ]);
  }
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Context state operation was aborted", {
    cause: signal.reason,
  });
}
