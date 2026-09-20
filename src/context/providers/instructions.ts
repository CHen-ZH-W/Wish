import type {
  ContextItem,
  ContextProvider,
} from "../../core/context/projector.js";
import type {
  ContextInput,
  ContextInstruction,
} from "../types.js";

const DEFAULT_PROVIDER_ID = "instructions";

export interface InstructionsContextProviderOptions {
  readonly id?: string;
}

/** Projects resolved Workspace instructions before the current User message. */
export class InstructionsContextProvider implements ContextProvider<ContextInput> {
  readonly id: string;
  private readonly itemIdPrefix: string;

  constructor(options: InstructionsContextProviderOptions = {}) {
    this.id = requireIdentifier(
      options.id ?? DEFAULT_PROVIDER_ID,
      "Instructions provider id",
    );
    this.itemIdPrefix = encodeURIComponent(this.id);
  }

  provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): readonly ContextItem[] {
    throwIfAborted(signal);
    const workspaceInstructions = snapshotInstructions(
      input.workspace.instructions,
      "Workspace instructions",
    );
    const items: ContextItem[] = [];

    for (const instruction of workspaceInstructions) {
      throwIfAborted(signal);
      items.push(Object.freeze({
        id: `${this.itemIdPrefix}:workspace:` + encodeURIComponent(instruction.id),
        kind: "instruction" as const,
        placement: "before_current_user" as const,
        message: Object.freeze({
          role: instruction.authority,
          content: instruction.content,
        }),
      }));
    }
    throwIfAborted(signal);
    return Object.freeze(items);
  }
}

function snapshotInstructions(
  instructions: readonly ContextInstruction[],
  label: string,
): readonly ContextInstruction[] {
  if (!Array.isArray(instructions)) {
    throw new Error(`${label} must be an array`);
  }
  const ids = new Set<string>();
  return Object.freeze(instructions.map((instruction) => {
    if (instruction === null || typeof instruction !== "object") {
      throw new Error(`${label} must contain instruction objects`);
    }
    const id = requireIdentifier(instruction.id, `${label} id`);
    if (ids.has(id)) {
      throw new Error(`Duplicate ${label.toLowerCase()} id: ${id}`);
    }
    ids.add(id);
    if (
      instruction.authority !== "system" &&
      instruction.authority !== "developer"
    ) {
      throw new Error(`${label} authority must be system or developer`);
    }
    if (
      typeof instruction.content !== "string" ||
      instruction.content.trim().length === 0
    ) {
      throw new Error(`${label} content must be a non-empty string`);
    }
    return Object.freeze({
      id,
      authority: instruction.authority,
      content: instruction.content,
    });
  }));
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Context instructions operation was aborted", {
    cause: signal.reason,
  });
}
