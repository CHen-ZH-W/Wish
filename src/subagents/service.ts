import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  CaptureSubagentRequest,
  CollectedSubagent,
  CollectSubagentRequest,
  InspectSubagentRequest,
  ListSubagentsRequest,
  ObserveSessionSubagentsRequest,
  SendSubagentRequest,
  SpawnSubagentRequest,
  StopSubagentRequest,
  SubagentRecord,
  SubagentEventListener,
  Subagents,
} from "./types.js";

/** Replaceable semantic child-agent lifecycle Definition. */
export abstract class SubagentsService extends Service implements Subagents {
  constructor(ctx: Context) {
    super(ctx, "subagents");
  }

  abstract spawn(request: SpawnSubagentRequest): Promise<SubagentRecord>;
  abstract list(request: ListSubagentsRequest): Promise<readonly SubagentRecord[]>;
  abstract observeSession(request: ObserveSessionSubagentsRequest): Promise<readonly SubagentRecord[]>;
  abstract inspect(request: InspectSubagentRequest): Promise<SubagentRecord | undefined>;
  abstract capture(request: CaptureSubagentRequest): Promise<string>;
  abstract send(request: SendSubagentRequest): Promise<void>;
  abstract stop(request: StopSubagentRequest): Promise<SubagentRecord>;
  abstract collect(request: CollectSubagentRequest): Promise<CollectedSubagent>;
  abstract subscribe(listener: SubagentEventListener): () => void;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagents: SubagentsService;
  }
}

export default SubagentsService;
