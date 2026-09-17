import {
  assertActiveToolAuthorizationGrant,
  normalizeToolCapabilityRequest,
  type ToolAuthorizationGrant,
  type ToolCapabilityRequest,
} from "./authorization.js";
import type {
  InvalidToolCall,
  ReadyToolCall,
  ToolCall,
  ToolCallParseResult,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionMode,
  ToolExecutionSnapshot,
  ToolInputParseResult,
  ToolRecoveryPolicy,
  UnparsedToolCall,
} from "./tool.js";

interface RegisteredToolDefinition<Context> {
  readonly descriptor: ToolDescriptor;
  parse(input: Readonly<Record<string, unknown>>): ToolInputParseResult<unknown>;
  resolveCapabilities(
    input: unknown,
    context: Context,
    signal?: AbortSignal,
  ): Promise<ToolCapabilityRequest> | ToolCapabilityRequest;
  execute(
    input: unknown,
    context: Context,
    grant: ToolAuthorizationGrant,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
}

export interface ToolRegistration {
  readonly descriptor: ToolDescriptor;
  unregister(): boolean;
}

export interface CaptureToolExecutionSnapshotInput {
  readonly authorityVersion: string;
  readonly availableTools?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Ordered registry for concrete Tool contributions. */
export class ToolRegistry<Context = unknown> {
  private readonly definitions = new Map<string, RegisteredToolDefinition<Context>>();
  private currentVersion = 0;

  get version(): number {
    return this.currentVersion;
  }

  register<Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, Context>,
  ): ToolRegistration {
    const descriptor = normalizeDescriptor(definition);
    if (this.definitions.has(descriptor.name)) {
      throw new Error(`Tool "${descriptor.name}" is already registered`);
    }
    const registered: RegisteredToolDefinition<Context> = {
      descriptor,
      parse: (input) => definition.parse(input),
      resolveCapabilities: (input, context, signal) =>
        definition.resolveCapabilities(input as Input, context, signal),
      execute: (input, context, grant, signal) =>
        definition.execute(input as Input, context, grant, signal),
    };
    this.definitions.set(descriptor.name, registered);
    this.currentVersion += 1;

    let active = true;
    return Object.freeze({
      descriptor,
      unregister: () => {
        if (!active) return false;
        active = false;
        if (this.definitions.get(descriptor.name) !== registered) return false;
        this.definitions.delete(descriptor.name);
        this.currentVersion += 1;
        return true;
      },
    });
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  describe(name: string): ToolDescriptor | undefined {
    return this.definitions.get(name)?.descriptor;
  }

  list(): readonly ToolDescriptor[] {
    return Object.freeze(
      [...this.definitions.values()].map((definition) => definition.descriptor),
    );
  }

  /** Exact model-visible Tool descriptors for one immutable Step snapshot. */
  listForSnapshot(snapshot: ToolExecutionSnapshot): readonly ToolDescriptor[] {
    if (snapshot.registryVersion !== this.currentVersion) {
      throw new Error("Tool Registry changed after this Step snapshot");
    }
    return Object.freeze(snapshot.availableTools.map((name) => {
      const definition = this.definitions.get(name);
      if (definition === undefined) {
        throw new Error(`Snapshot Tool "${name}" is not registered`);
      }
      return definition.descriptor;
    }));
  }

  captureSnapshot(
    input: CaptureToolExecutionSnapshotInput,
  ): ToolExecutionSnapshot {
    const availableTools = input.availableTools === undefined
      ? [...this.definitions.keys()]
      : validateAvailableTools(input.availableTools, this.definitions);
    return Object.freeze({
      schemaVersion: 1 as const,
      registryVersion: this.currentVersion,
      authorityVersion: requireIdentifier(
        input.authorityVersion,
        "Tool authority version",
      ),
      availableTools: Object.freeze(availableTools),
      ...(input.metadata === undefined
        ? {}
        : {
            metadata: deepFreezePlainValue({ ...input.metadata }) as Readonly<
              Record<string, unknown>
            >,
          }),
    });
  }

  parseCall(call: UnparsedToolCall): ToolCallParseResult {
    const id = requireIdentifier(call.id, "Tool call id");
    const name = requireIdentifier(call.name, "Tool name");
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      return invalidParseResult(id, name, "not_found", `Tool "${name}" is not registered`);
    }

    let input: unknown;
    try {
      input = JSON.parse(call.argumentsJson) as unknown;
    } catch {
      return invalidParseResult(
        id,
        name,
        "invalid_input",
        `Tool "${name}" arguments must be valid JSON`,
      );
    }
    if (!isPlainRecord(input)) {
      return invalidParseResult(
        id,
        name,
        "invalid_input",
        `Tool "${name}" arguments must be a JSON object`,
      );
    }

    try {
      const parsed = definition.parse(deepFreezePlainValue(input) as Readonly<
        Record<string, unknown>
      >);
      if (!parsed.ok) {
        return invalidParseResult(id, name, "invalid_input", parsed.message);
      }
      const ready: ReadyToolCall = Object.freeze({
        status: "ready" as const,
        id,
        name,
        input: deepFreezePlainValue(parsed.input),
      });
      return Object.freeze({ ok: true as const, call: ready });
    } catch (error: unknown) {
      return invalidParseResult(
        id,
        name,
        "invalid_input",
        error instanceof Error ? error.message : `Tool "${name}" input is invalid`,
      );
    }
  }

  executionMode(call: ToolCall): ToolExecutionMode {
    if (call.status === "invalid") return "sequential";
    return this.definitions.get(call.name)?.descriptor.executionMode ?? "sequential";
  }

  async resolveCapabilities(
    call: ReadyToolCall,
    context: Context,
    signal?: AbortSignal,
  ): Promise<ToolCapabilityRequest> {
    const definition = this.requireDefinition(call.name);
    return normalizeToolCapabilityRequest(
      await definition.resolveCapabilities(call.input, context, signal),
    );
  }

  /** Called only by ToolExecutor while its one-shot Grant is active. */
  async execute(
    call: ReadyToolCall,
    context: Context,
    grant: ToolAuthorizationGrant,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const registryVersion = this.currentVersion;
    assertActiveToolAuthorizationGrant(grant, {
      call,
      callId: call.id,
      toolName: call.name,
      registryVersion,
    });
    if (
      this.currentVersion !== registryVersion ||
      grant.subject.generation !== this.currentVersion
    ) {
      throw new Error(
        `Tool authorization Grant ${grant.grantId} registry is stale`,
      );
    }
    const definition = this.requireDefinition(call.name);
    return await definition.execute(call.input, context, grant, signal);
  }

  private requireDefinition(name: string): RegisteredToolDefinition<Context> {
    const definition = this.definitions.get(name);
    if (definition === undefined) throw new Error(`Tool "${name}" is not registered`);
    return definition;
  }
}

function normalizeDescriptor<Context>(
  definition: ToolDefinition<string, unknown, unknown, Context>,
): ToolDescriptor {
  const name = requireIdentifier(definition.name, "Tool name");
  const description = requireText(definition.description, "Tool description");
  const inputSchemaJson = validateInputSchema(definition.inputSchemaJson);
  if (
    definition.executionMode !== "parallel" &&
    definition.executionMode !== "sequential"
  ) {
    throw new Error(`Tool "${name}" has an invalid execution mode`);
  }
  const recoveryPolicy: ToolRecoveryPolicy =
    definition.recoveryPolicy ?? "needs-reconciliation";
  if (!isRecoveryPolicy(recoveryPolicy)) {
    throw new Error(`Tool "${name}" has an invalid recovery policy`);
  }
  return Object.freeze({
    name,
    description,
    inputSchemaJson,
    executionMode: definition.executionMode,
    recoveryPolicy,
  });
}

function validateInputSchema(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Tool inputSchemaJson must not be empty");
  }
  let schema: unknown;
  try {
    schema = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Tool inputSchemaJson must be valid JSON");
  }
  if (!isPlainRecord(schema)) {
    throw new Error("Tool inputSchemaJson must describe a JSON object");
  }
  return value;
}

function invalidParseResult(
  id: string,
  name: string,
  code: InvalidToolCall["error"]["code"],
  message: string,
): ToolCallParseResult {
  return Object.freeze({
    ok: false as const,
    call: Object.freeze({
      status: "invalid" as const,
      id,
      name,
      error: Object.freeze({
        code,
        message,
        retryable: false,
        phase: "received" as const,
      }),
    }),
  });
}

function validateAvailableTools<Context>(
  names: readonly string[],
  definitions: ReadonlyMap<string, RegisteredToolDefinition<Context>>,
): string[] {
  if (!Array.isArray(names)) throw new Error("availableTools must be an array");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = requireIdentifier(rawName, "Available Tool name");
    if (seen.has(name)) throw new Error(`Available Tool "${name}" is duplicated`);
    if (!definitions.has(name)) {
      throw new Error(`Available Tool "${name}" is not registered`);
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

function isRecoveryPolicy(value: string): value is ToolRecoveryPolicy {
  return value === "retry-safe" ||
    value === "resumable" ||
    value === "needs-reconciliation" ||
    value === "terminal-failed";
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function deepFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezePlainValue));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
