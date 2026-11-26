import type { Model, ModelRef } from "../../core/model/model.js";
import { EXTRACTION_PROMPT } from "./prompts.js";
import { content } from "../validation.js";
import { redactMemorySecrets } from "../secrets.js";
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
    return this.extractPart(evidence, signal, "whole");
  }
  private async extractPart(evidence: CurationEvidence, signal: AbortSignal, part: string): Promise<readonly ExtractedMemory[]> {
    try {
    const parsed = await memoryJson(this.model, this.ref, "memory-curation", EXTRACTION_PROMPT,
      { outcome: evidence.outcome, appliesTo: evidence.appliesTo, sourceId: evidence.id,
        cwd: evidence.cwd, rolloutPath: evidence.rolloutPath, sessionId: evidence.sessionId, part,
        occurredAt: evidence.occurredAt, untrustedRollout: redactMemorySecrets(evidence.text) }, signal) as Record<string, unknown>;
    if (typeof parsed?.raw_memory === "string" && typeof parsed.rollout_summary === "string") {
      if (Object.keys(parsed).some(key => !["raw_memory", "rollout_summary", "rollout_slug"].includes(key))) throw new Error("Unexpected memory extraction field");
      if (!Object.hasOwn(parsed, "rollout_slug")) throw new Error("Missing rollout slug field");
      if (parsed.rollout_slug !== undefined && parsed.rollout_slug !== null && typeof parsed.rollout_slug !== "string") throw new Error("Invalid rollout slug");
      if (!parsed.raw_memory.trim() || !parsed.rollout_summary.trim()) return [];
      return [{ ...content({ title: typeof parsed.rollout_slug === "string" && parsed.rollout_slug.trim() ? parsed.rollout_slug : evidence.id,
        content: redactMemorySecrets(parsed.raw_memory), keywords: [], appliesTo: evidence.appliesTo, evidence: evidence.references }),
        rolloutSummary: redactMemorySecrets(parsed.rollout_summary), ...(typeof parsed.rollout_slug === "string" ? { rolloutSlug: redactMemorySecrets(parsed.rollout_slug) } : {}) }];
    }
    // Persisted legacy jobs migrate in validation.ts; every new extraction uses the current schema.
    throw new Error("Invalid curation model output");
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof MemoryContextOverflowError)) throw error;
      const halves = splitEvidence(evidence.text);
      if (!halves) throw error;
      const first = await this.extractPart({ ...evidence, text: halves[0] }, signal, `${part}.1`);
      const second = await this.extractPart({ ...evidence, text: halves[1] }, signal, `${part}.2`);
      return [...first, ...second];
    }
  }
}

/** Use the configured model's own limits; curation adds no token, character or item quota. */
export async function memoryJson(model: Model, ref: ModelRef, purpose: string, instructions: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  let output = "", done = false;
  for await (const event of model.stream({ model: ref, tools: [], metadata: { purpose },
    ...(purpose === "memory-curation" ? { responseSchema: { name: "memory_extraction", schema: { type: "object", properties: { raw_memory: { type: "string" }, rollout_summary: { type: "string" }, rollout_slug: { type: ["string", "null"] } }, required: ["raw_memory", "rollout_summary", "rollout_slug"], additionalProperties: false } } } : {}),
    instructions: [{ role: "system", content: instructions }], messages: [{ role: "user", content: JSON.stringify(input) }] }, signal)) {
    signal.throwIfAborted();
    if (done) throw new Error("Memory model emitted after terminal event");
    if (event.type === "tool_call") throw new Error("Memory model cannot call tools");
    if (event.type === "error") {
      if (event.error.code === "context_overflow") throw new MemoryContextOverflowError();
      throw new Error(`Memory model failed: ${event.error.code}`);
    }
    if (event.type === "text_delta") output += event.text;
    if (event.type === "done") {
      if (event.finishReason !== undefined && !["stop", "completed", "end_turn"].includes(event.finishReason)) throw new Error("Memory model output was incomplete");
      done = true;
    }
  }
  if (!done || !output.trim()) throw new Error("Memory model did not produce a complete response");
  return JSON.parse(output);
}

class MemoryContextOverflowError extends Error { constructor() { super("Memory evidence exceeds this model's context window"); } }
function splitEvidence(value: string): readonly [string, string] | undefined {
  try {
    const parsed = JSON.parse(value) as { untrustedCommittedMessages?: unknown[] };
    const messages = parsed.untrustedCommittedMessages;
    if (Array.isArray(messages) && messages.length > 1) {
      const middle = Math.floor(messages.length / 2);
      return [JSON.stringify({ ...parsed, untrustedCommittedMessages: messages.slice(0, middle) }), JSON.stringify({ ...parsed, untrustedCommittedMessages: messages.slice(middle) })];
    }
  } catch { /* Other evidence adapters may supply plain text. */ }
  const chars = [...value];
  if (chars.length < 2) return undefined;
  const middle = Math.floor(chars.length / 2);
  return [chars.slice(0, middle).join(""), chars.slice(middle).join("")];
}

export { ModelMemoryExtractor as ModelMemoryCandidateExtractor, RecapMemoryExtractor as RecapMemoryCandidateExtractor };
