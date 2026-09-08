import type { AgentProtocol } from "../src/core/agent/agent.js";
import {
  createWishApplication,
  type WishApplicationOptions,
} from "../src/apps/application.js";
import type {
  ContextWorkspaceFacts,
} from "../src/context/types.js";
import type {
  WishAgentProtocol,
  WishApplication,
  WishOutputEvent,
  WishRunHandle,
  WishWorkspaceResolver,
} from "../src/apps/types.js";

const workspace: WishWorkspaceResolver = {
  resolve({ session }): ContextWorkspaceFacts {
    return {
      cwd: session.scope,
      instructions: [],
    };
  },
};

declare const application: WishApplication;
declare const applicationOptions: WishApplicationOptions;

const composed: WishApplication = createWishApplication(applicationOptions);

const session = application.createSession({
  sessionId: "session-1",
  workspaceRoot: "/workspace",
  title: "Session",
});
const handle: WishRunHandle = await application.startRun({
  sessionId: "session-1",
  payload: {
    text: "hello",
    model: { provider: "provider", model: "model" },
  },
});
const events: AsyncIterable<WishOutputEvent> = application.observeRun(
  handle.runId,
  { afterSequence: 0 },
);
const control = application.controlRun(handle.runId, {
  type: "follow_up",
  payload: { text: "continue" },
});
const protocol: AgentProtocol = {} as WishAgentProtocol;

void workspace;
void composed;
void session;
void events;
void control;
void protocol;
