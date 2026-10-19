import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { AgentScope } from "../composition/agent-scope.js";

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
  private readonly scoped = new Map<AgentScope, Map<string, RegisteredSystemPromptSection>>();
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
    this.work = new PluginWorkOwner(ctx, { code: "system_prompt", codeReload: true });
  }

  /** Register one section for exactly the lifetime of the calling plugin Fiber. */
  register(section: SystemPromptSection): SystemPromptRegistration {
    this.work.assertAttached();
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

  /** Register a Prompt section visible only to this Agent and its descendants. */
  registerScoped(owner: Context, scope: AgentScope, section: SystemPromptSection): SystemPromptRegistration {
    this.work.assertAttached();
    const normalized = normalizeSection(section);
    if (this.scoped.get(scope)?.has(normalized.id)) {
      throw new Error(`System Prompt section ${JSON.stringify(normalized.id)} is already registered in this Agent Scope`);
    }
    const entries = this.scoped.get(scope) ?? new Map<string, RegisteredSystemPromptSection>();
    entries.set(normalized.id, normalized);
    this.scoped.set(scope, entries);
    let active = true;
    const unregister = (): boolean => {
      if (!active) return false;
      active = false;
      if (entries.get(normalized.id) === normalized) entries.delete(normalized.id);
      if (entries.size === 0 && this.scoped.get(scope) === entries) this.scoped.delete(scope);
      return true;
    };
    let detach = () => {};
    try {
      detach = scope.own(() => { unregister(); });
      owner.effect(() => () => { unregister(); detach(); },
        `systemPrompt.registerScoped(${JSON.stringify(normalized.id)})`);
    } catch (error: unknown) {
      unregister();
      detach();
      throw error;
    }
    return Object.freeze({ section: normalized, unregister: () => {
      const removed = unregister();
      detach();
      return removed;
    } });
  }

  /** Resolve the exact ordered sections visible to one immutable Step. */
  capture(agentScope?: AgentScope): readonly RegisteredSystemPromptSection[] {
    this.work.assertOpen();
    const visible = new Map(this.sections);
    for (const scope of agentScope?.chain() ?? []) {
      for (const section of this.scoped.get(scope)?.values() ?? []) visible.set(section.id, section);
    }
    return Object.freeze([...visible.values()].sort(compareSections));
  }

  assemble(
    input: SystemPromptAssemblyInput,
  ): readonly RegisteredSystemPromptSection[] {
    this.work.assertOpen();
    const availableTools = new Set(
      input.availableTools.map((name) => requireIdentifier(name, "Tool name")),
    );
    return Object.freeze(
      [...(input.sections ?? this.capture(input.agentScope))]
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
    return coalesceModelInstructions(
      this.assemble(input)
        .filter((section) => section.placement === "stable_prefix")
        .map((section) => ({
          role: section.authority,
          content: section.content,
        })),
    );
  }
}

/** Preserve section ownership internally while minimizing protocol instruction boundaries. */
export function coalesceModelInstructions(
  instructions: readonly ModelInstruction[],
): readonly ModelInstruction[] {
  const result: ModelInstruction[] = [];
  for (const instruction of instructions) {
    const previous = result.at(-1);
    if (previous?.role === instruction.role) {
      result[result.length - 1] = Object.freeze({
        role: previous.role,
        content: `${previous.content}\n\n${instruction.content}`,
      });
    } else {
      result.push(Object.freeze({
        role: instruction.role,
        content: instruction.content,
      }));
    }
  }
  return Object.freeze(result);
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
