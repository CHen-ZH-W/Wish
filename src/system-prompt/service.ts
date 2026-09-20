import { Service, type Context } from "@deepseek-ai/cordis";

import type { ModelInstruction } from "../core/model/model.js";

import type {
  RegisteredSystemPromptSection,
  SystemPromptAssemblyInput,
  SystemPromptRegistration,
  SystemPromptSection,
} from "./types.js";

/** Process-local registry and deterministic assembler for System Prompt sections. */
export class SystemPrompt extends Service {
  private readonly sections = new Map<string, RegisteredSystemPromptSection>();

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  /** Register one section for exactly the lifetime of the calling plugin Fiber. */
  register(section: SystemPromptSection): SystemPromptRegistration {
    const normalized = normalizeSection(section);
    if (this.sections.has(normalized.id)) {
      throw new Error(
        `System Prompt section ${JSON.stringify(normalized.id)} is already registered`,
      );
    }
    this.sections.set(normalized.id, normalized);
    let active = true;
    const registration: SystemPromptRegistration = Object.freeze({
      section: normalized,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        if (this.sections.get(normalized.id) !== normalized) return false;
        this.sections.delete(normalized.id);
        return true;
      },
    });
    try {
      this.ctx.effect(
        () => () => {
          registration.unregister();
        },
        `systemPrompt.register(${JSON.stringify(normalized.id)})`,
      );
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  /** Resolve the exact ordered sections visible to one immutable Step. */
  assemble(
    input: SystemPromptAssemblyInput,
  ): readonly RegisteredSystemPromptSection[] {
    const availableTools = new Set(
      input.availableTools.map((name) => requireIdentifier(name, "Tool name")),
    );
    return Object.freeze(
      [...this.sections.values()]
        .filter((section) =>
          section.requiredTools.every((name) => availableTools.has(name))
        )
        .sort(compareSections),
    );
  }

  /** Stable sections for the protocol-level instruction channel. */
  assembleInstructions(
    input: SystemPromptAssemblyInput,
  ): readonly ModelInstruction[] {
    return Object.freeze(
      this.assemble(input)
        .filter((section) => section.placement === "stable_prefix")
        .map((section) => Object.freeze({
          role: section.authority,
          content: section.content,
        })),
    );
  }
}

function normalizeSection(
  section: SystemPromptSection,
): RegisteredSystemPromptSection {
  if (section === null || typeof section !== "object") {
    throw new TypeError("System Prompt section must be an object");
  }
  const id = requireIdentifier(section.id, "System Prompt section id");
  if (
    typeof section.content !== "string" ||
    section.content.trim().length === 0
  ) {
    throw new TypeError(
      `System Prompt section ${JSON.stringify(id)} content must be non-empty text`,
    );
  }
  const authority = section.authority ?? "developer";
  if (authority !== "system" && authority !== "developer") {
    throw new TypeError(
      `System Prompt section ${JSON.stringify(id)} has invalid authority`,
    );
  }
  const order = section.order ?? 0;
  if (!Number.isSafeInteger(order)) {
    throw new TypeError(
      `System Prompt section ${JSON.stringify(id)} order must be a safe integer`,
    );
  }
  const requiredTools = Object.freeze(
    (section.requiredTools ?? []).map((name) =>
      requireIdentifier(name, `System Prompt section ${JSON.stringify(id)} Tool`)
    ),
  );
  if (new Set(requiredTools).size !== requiredTools.length) {
    throw new TypeError(
      `System Prompt section ${JSON.stringify(id)} has duplicate Tool requirements`,
    );
  }
  const placement = section.placement ??
    (requiredTools.length === 0 ? "stable_prefix" : "dynamic_tail");
  if (placement !== "stable_prefix" && placement !== "dynamic_tail") {
    throw new TypeError(
      `System Prompt section ${JSON.stringify(id)} has invalid placement`,
    );
  }
  if (requiredTools.length > 0 && placement !== "dynamic_tail") {
    throw new TypeError(
      `Tool-dependent System Prompt section ${JSON.stringify(id)} must use dynamic_tail`,
    );
  }
  return Object.freeze({
    id,
    content: section.content,
    authority,
    order,
    requiredTools,
    placement,
  });
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function compareSections(
  left: RegisteredSystemPromptSection,
  right: RegisteredSystemPromptSection,
): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    systemPrompt: SystemPrompt;
  }
}

export default SystemPrompt;
