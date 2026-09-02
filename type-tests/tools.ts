import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationService,
  type ToolDefinition,
  type ToolExecutionScope,
} from "../src/core/tools/scheduler.js";

interface ToolContext {
  readonly root: string;
}

const definition: ToolDefinition<"read", { readonly path: string }, string, ToolContext> = {
  name: "read",
  description: "Read one resource",
  inputSchemaJson: '{"type":"object"}',
  executionMode: "parallel",
  recoveryPolicy: "retry-safe",
  parse(input) {
    return typeof input.path === "string"
      ? { ok: true, input: { path: input.path } }
      : { ok: false, message: "path is required" };
  },
  resolveCapabilities(input) {
    return {
      requirements: [{ capability: "filesystem.read", paths: [input.path] }],
    };
  },
  execute(input, _context, grant) {
    assertActiveToolAuthorizationGrant(grant, {
      callId: grant.callId,
      toolName: "read",
    });
    return input.path;
  },
};

const authorization: ToolAuthorizationService<ToolContext> = {
  authorize() {
    return { status: "allowed", policyVersion: "policy-1" };
  },
  revalidate() {
    return { status: "valid", policyVersion: "policy-1" };
  },
};

const registry = new ToolRegistry<ToolContext>();
registry.register(definition);
const executor = new ToolExecutor({ registry, authorization });
const scheduler = new BoundedToolScheduler({ executor });
const scope: ToolExecutionScope = {
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
};
const parsed = registry.parseCall({
  id: "call-1",
  name: "read",
  argumentsJson: '{"path":"README.md"}',
});

if (parsed.ok) {
  void scheduler.schedule({
    calls: [parsed.call],
    context: { root: "/workspace" },
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
}
