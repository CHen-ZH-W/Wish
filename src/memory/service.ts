import { Service, type Context } from "@deepseek-ai/cordis";
import type { ChangeMemoryStatusRequest, ConsolidateMemoryRequest, DecideMemoryRequest, Memory, MemoryCandidate, MemoryDocument, MemoryLibraryLocation, MemoryQuery, MemorySnapshot, MemoryState, ProposeMemoryRequest } from "./types.js";
export abstract class MemoryService extends Service implements Memory {
  private readonly modelFileFilters = new Map<symbol, (files: readonly MemoryDocument[], signal?: AbortSignal) => Promise<readonly MemoryDocument[]>>();
  private readonly sourceReaders = new Map<symbol, (sourceId: string, signal?: AbortSignal) => Promise<string | undefined>>();
  constructor(ctx: Context) { super(ctx, "memory"); }
  abstract readonly libraryId: string;
  get sharedLibrary(): MemoryLibraryLocation | undefined { return undefined; }
  async files(signal?: AbortSignal): Promise<readonly MemoryDocument[]> { return (await this.state(signal)).documents.filter(item => item.status === "accepted"); }
  async modelFiles(signal?: AbortSignal): Promise<readonly MemoryDocument[]> {
    let files = await this.files(signal);
    // Without a Skills owner, Memory cannot authorize following a generated Skill.
    if (!this.modelFileFilters.size) return files.filter(item => !item.path?.startsWith("skills/"));
    for (const filter of this.modelFileFilters.values()) files = await filter(files, signal);
    return files;
  }
  registerModelFileFilter(filter: (files: readonly MemoryDocument[], signal?: AbortSignal) => Promise<readonly MemoryDocument[]>): () => void {
    const token = Symbol("memory-model-file-filter"); this.modelFileFilters.set(token, filter);
    return () => { this.modelFileFilters.delete(token); };
  }
  readSource(sourceId: string, signal?: AbortSignal): Promise<string | undefined> { return [...this.sourceReaders.values()].at(-1)?.(sourceId, signal) ?? Promise.resolve(undefined); }
  registerSourceReader(reader: (sourceId: string, signal?: AbortSignal) => Promise<string | undefined>): () => void {
    const token = Symbol("memory-source-reader");
    this.sourceReaders.set(token, reader);
    return () => { this.sourceReaders.delete(token); };
  }
  abstract state(signal?: AbortSignal): Promise<MemoryState>;
  abstract query(input?: MemoryQuery): Promise<readonly MemoryDocument[]>;
  abstract read(id: string, signal?: AbortSignal): Promise<MemoryDocument | undefined>;
  abstract propose(input: ProposeMemoryRequest): Promise<MemoryCandidate>;
  abstract decide(input: DecideMemoryRequest): Promise<MemoryCandidate>;
  abstract changeStatus(input: ChangeMemoryStatusRequest): Promise<MemoryDocument>;
  abstract consolidate(input: ConsolidateMemoryRequest): Promise<number>;
  abstract snapshot(input?: MemoryQuery): Promise<MemorySnapshot>;
  abstract close(): Promise<void>;
}
declare module "@deepseek-ai/cordis" { interface Context { memory: MemoryService; } }
