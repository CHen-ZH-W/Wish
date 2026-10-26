import type { Model, ModelRef } from "../../core/model/model.js";
import { EXTRACTION_PROMPT } from "./prompts.js";
import { content } from "../validation.js";
import type { CurationEvidence, ExtractedMemory, MemoryExtractor } from "./types.js";

/** Explicit deterministic adapter for hosts and tests; production uses model extraction. */
export class RecapMemoryExtractor implements MemoryExtractor {
  async extract(evidence: CurationEvidence, signal: AbortSignal): Promise<readonly ExtractedMemory[]> {
    signal.throwIfAborted();
    return Object.freeze([content({ title: `Execution recap: ${evidence.runId ?? evidence.id}`,
      content: `Execution outcome: ${evidence.outcome}. This is source material, not proof that tests or validation passed.\n\n${evidence.text}`,
      appliesTo: evidence.appliesTo, keywords: ["execution-recap", evidence.outcome], evidence: evidence.references })]);
  }
}

/** Phase 1: full committed evidence -> durable raw memories. */
export class ModelMemoryExtractor implements MemoryExtractor {
  private readonly ref: ModelRef;
  constructor(private readonly model: Model, ref: ModelRef) { this.ref = Object.freeze({ ...ref }); }
  async extract(evidence: CurationEvidence, signal: AbortSignal): Promise<readonly ExtractedMemory[]> {
    const parsed = await memoryJson(this.model, this.ref, "memory-curation", EXTRACTION_PROMPT,
      { outcome: evidence.outcome, appliesTo: evidence.appliesTo, sourceId: evidence.id,
        occurredAt: evidence.occurredAt, untrustedRollout: evidence.text }, signal) as Record<string, unknown>;
    if (typeof parsed?.raw_memory === "string" && typeof parsed.rollout_summary === "string") {
      if (!parsed.raw_memory.trim() || !parsed.rollout_summary.trim()) return [];
      if (parsed.rollout_slug !== undefined && parsed.rollout_slug !== null && typeof parsed.rollout_slug !== "string") throw new Error("Invalid rollout slug");
      return [{ ...content({ title: typeof parsed.rollout_slug === "string" && parsed.rollout_slug.trim() ? parsed.rollout_slug : evidence.id,
        content: parsed.raw_memory, keywords: [], appliesTo: evidence.appliesTo, evidence: evidence.references }),
        rolloutSummary: parsed.rollout_summary, ...(typeof parsed.rollout_slug === "string" ? { rolloutSlug: parsed.rollout_slug } : {}) }];
    }
    // Read the earlier provider response shape during upgrades; new requests use rollout artifacts.
    if (!parsed || !Array.isArray(parsed.memories)) throw new Error("Invalid curation model output");
    return parsed.memories.map((item: { title: string; content: string; keywords: string[] }) => content({
      title: item?.title, content: item?.content, keywords: item?.keywords, appliesTo: evidence.appliesTo, evidence: evidence.references,
    }));
  }
}

/** Use the configured model's own limits; curation adds no token, character or item quota. */
export async function memoryJson(model: Model, ref: ModelRef, purpose: string, instructions: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  let output = "", done = false;
  for await (const event of model.stream({ model: ref, tools: [], metadata: { purpose },
    instructions: [{ role: "system", content: instructions }], messages: [{ role: "user", content: JSON.stringify(input) }] }, signal)) {
    signal.throwIfAborted();
    if (done) throw new Error("Memory model emitted after terminal event");
    if (event.type === "tool_call") throw new Error("Memory model cannot call tools");
    if (event.type === "error") throw new Error(`Memory model failed: ${event.error.code}`);
    if (event.type === "text_delta") output += event.text;
    if (event.type === "done") {
      if (event.finishReason !== undefined && !["stop", "completed", "end_turn"].includes(event.finishReason)) throw new Error("Memory model output was incomplete");
      done = true;
    }
  }
  if (!done || !output.trim()) throw new Error("Memory model did not produce a complete response");
  return JSON.parse(output);
}

export { ModelMemoryExtractor as ModelMemoryCandidateExtractor, RecapMemoryExtractor as RecapMemoryCandidateExtractor };
