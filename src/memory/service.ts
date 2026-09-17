import { Service, type Context } from "@deepseek-ai/cordis";
import type { ChangeMemoryStatusRequest, DecideMemoryRequest, Memory, MemoryCandidate, MemoryDocument, MemoryQuery, MemorySnapshot, MemoryState, ProposeMemoryRequest } from "./types.js";
export abstract class MemoryService extends Service implements Memory {
  constructor(ctx: Context) { super(ctx, "memory"); }
  abstract readonly libraryId: string;
  abstract state(signal?: AbortSignal): Promise<MemoryState>;
  abstract query(input?: MemoryQuery): Promise<readonly MemoryDocument[]>;
  abstract read(id: string, signal?: AbortSignal): Promise<MemoryDocument | undefined>;
  abstract propose(input: ProposeMemoryRequest): Promise<MemoryCandidate>;
  abstract decide(input: DecideMemoryRequest): Promise<MemoryCandidate>;
  abstract changeStatus(input: ChangeMemoryStatusRequest): Promise<MemoryDocument>;
  abstract snapshot(input?: MemoryQuery): Promise<MemorySnapshot>;
  abstract close(): Promise<void>;
}
declare module "@deepseek-ai/cordis" { interface Context { memory: MemoryService; } }
