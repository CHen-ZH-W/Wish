import assert from "node:assert/strict";
import test from "node:test";

import {
  InstructionsContextProvider,
  StateContextProvider,
} from "../dist/context/index.js";
import { ContextProjector } from "../dist/core/context/projector.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function contextInput(overrides = {}) {
  return {
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
    sessionId: "session-1",
    model,
    workspace: {
      cwd: "/workspace/one",
      instructions: [
        {
          id: "workspace-rules",
          authority: "developer",
          content: "Workspace rules",
          sourcePath: "ignored",
        },
      ],
    },
    runtime: {
      capturedAt: "2026-09-03T12:00:00.000Z",
      stateVersion: 2,
      userTurnOrdinal: 3,
      stepOrdinal: 4,
    },
    ...overrides,
  };
}

test("projects Agent then workspace instructions as a stable prefix", () => {
  const configured = [
    {
      id: "identity",
      authority: "system",
      content: "Agent identity",
      metadata: "ignored",
    },
    {
      id: "behavior",
      authority: "developer",
      content: "Agent behavior",
    },
  ];
  const provider = new InstructionsContextProvider({
    agentInstructions: configured,
  });
  configured[0].content = "mutated after construction";

  const first = provider.provide(contextInput());
  const second = provider.provide(contextInput());

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.id), [
    "instructions:agent:identity",
    "instructions:agent:behavior",
    "instructions:workspace:workspace-rules",
  ]);
  assert.deepEqual(first.map((item) => item.message), [
    { role: "system", content: "Agent identity" },
    { role: "developer", content: "Agent behavior" },
    { role: "developer", content: "Workspace rules" },
  ]);
  assert.equal(first.every((item) => item.kind === "instruction"), true);
  assert.equal(first.every((item) => item.placement === "stable_prefix"), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0].message), true);
});

test("rejects ambiguous instruction ids, authority, and content", () => {
  assert.throws(() => new InstructionsContextProvider({
    agentInstructions: [
      { id: "same", authority: "developer", content: "one" },
      { id: "same", authority: "developer", content: "two" },
    ],
  }), /Duplicate agent instructions id/u);

  const invalidAuthority = new InstructionsContextProvider({
    agentInstructions: [],
  });
  assert.throws(() => invalidAuthority.provide(contextInput({
    workspace: {
      cwd: "/workspace",
      instructions: [{ id: "bad", authority: "user", content: "bad" }],
    },
  })), /authority must be system or developer/u);

  assert.throws(() => new InstructionsContextProvider({
    agentInstructions: [{ id: "empty", authority: "developer", content: "  " }],
  }), /content must be a non-empty string/u);
});

test("renders a fresh explicit State item for every Step", () => {
  const provider = new StateContextProvider();
  const first = provider.provide(contextInput());
  const second = provider.provide(contextInput({
    runId: "run-2",
    stepId: "step-2",
    workspace: { cwd: "/workspace/two", instructions: [] },
    runtime: {
      capturedAt: "2026-09-03T12:01:00.000Z",
      stateVersion: 3,
      userTurnOrdinal: 3,
      stepOrdinal: 5,
    },
  }));

  assert.equal(first.length, 1);
  assert.equal(first[0].id, "state:current-step");
  assert.equal(first[0].kind, "state");
  assert.equal(first[0].placement, "dynamic_tail");
  assert.equal(first[0].message.role, "developer");
  assert.match(first[0].message.content, /"cwd": "\/workspace\/one"/u);
  assert.match(first[0].message.content, /"stateVersion": 2/u);
  assert.match(first[0].message.content, /"id": "step-1"/u);
  assert.match(second[0].message.content, /"cwd": "\/workspace\/two"/u);
  assert.match(second[0].message.content, /"stateVersion": 3/u);
  assert.match(second[0].message.content, /"id": "step-2"/u);
  assert.notEqual(first[0].message.content, second[0].message.content);
});

test("propagates abort without producing partial instruction or state items", () => {
  const reason = new Error("stop providers");
  const controller = new AbortController();
  controller.abort(reason);
  const instructions = new InstructionsContextProvider({
    agentInstructions: [
      { id: "identity", authority: "system", content: "identity" },
    ],
  });

  assert.throws(() => instructions.provide(contextInput(), controller.signal), reason);
  assert.throws(
    () => new StateContextProvider().provide(contextInput(), controller.signal),
    reason,
  );
});

test("integrates stable instructions and dynamic state around the current user", async () => {
  const providers = [
    new InstructionsContextProvider({
      agentInstructions: [
        { id: "identity", authority: "system", content: "Agent identity" },
      ],
    }),
    new StateContextProvider(),
  ];
  const projection = await new ContextProjector().projectFromProviders({
    request: {
      model,
      messages: [
        { role: "system", content: "Core system" },
        { role: "user", content: "Current request" },
      ],
      tools: [],
    },
    providers,
    providerInput: contextInput(),
    currentUserMessageIndex: 1,
  });

  assert.equal(projection.status, "ready");
  assert.deepEqual(
    projection.request.messages.slice(0, 3).map((message) => message.content),
    ["Core system", "Agent identity", "Workspace rules"],
  );
  assert.match(
    projection.request.messages[3].content,
    /Current execution state for this Step/u,
  );
  assert.equal(projection.request.messages[4].content, "Current request");
});
