import type {
  AgentLoopInputRenderer,
  AgentLoopMemory,
  AgentLoopResult,
} from "../src/core/agent-loop/agent-loop.js";
import type { StepPipeline } from "../src/core/runtime/runtime.js";
import {
  createFileSessionResources,
  InMemorySessionStore,
  SessionHistoryAdapter,
  SessionManager,
  SessionTranscriptPipeline,
  createSessionInputRenderer,
  type SessionStore,
} from "../src/sessions/index.js";
import {
  FileSessionStore,
} from "../src/storage/sessions/file-session-store.js";

const memory: SessionStore = new InMemorySessionStore();
const sessions = new SessionManager(memory);
const history = new SessionHistoryAdapter({ sessions });
const resources = createFileSessionResources("/tmp/wish-session-type-test");
const file: SessionStore = new FileSessionStore({
  rootDirectory: "/tmp/wish-session-type-test",
});

declare const renderer: AgentLoopInputRenderer<{ readonly text: string }>;
const input: AgentLoopInputRenderer<{ readonly text: string }> =
  createSessionInputRenderer({ delegate: renderer, sessions });

declare const recovering: StepPipeline<
  { readonly model: string },
  { readonly text: string },
  AgentLoopMemory,
  AgentLoopResult
>;
const transcript: StepPipeline<
  { readonly model: string },
  { readonly text: string },
  AgentLoopMemory,
  AgentLoopResult
> = new SessionTranscriptPipeline({ delegate: recovering, sessions });

void history.context;
void history.compaction;
void resources;
void file;
void input;
void transcript;
