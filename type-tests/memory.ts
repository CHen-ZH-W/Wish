import type { Context } from "@deepseek-ai/cordis";
import { MemoryRuntime, InMemoryStateStore, type Memory, type MemorySnapshot, type ProposeMemoryRequest } from "../src/memory/index.js";
import { MemoryContextProvider } from "../src/memory/consumers/context.js";
import { createMemoryTools } from "../src/memory/consumers/model-tools.js";

const memory: Memory = new MemoryRuntime(new InMemoryStateStore());
const provider = new MemoryContextProvider(memory);
const tools = createMemoryTools(memory);
async function snapshot(): Promise<MemorySnapshot> { return memory.snapshot(); }
function service(ctx: Context): Memory { return ctx.memory; }
function proposal(input: ProposeMemoryRequest) { return memory.propose(input); }
// @ts-expect-error Durable knowledge cannot be published without a human decision operation.
memory.decide({ candidateId: "candidate", decision: "accept" });
// @ts-expect-error Snapshots are read-only knowledge, not mutable domain state.
function mutate(value: MemorySnapshot) { value.documents.push({}); }
void [provider, tools, snapshot, service, proposal, mutate];
