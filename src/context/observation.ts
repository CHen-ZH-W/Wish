import { ContextProjector, type ContextProjection, type ContextProjectorServices, type ContextProviderProjectionInput } from "../core/context/projector.js";
import type { ContextInput } from "./types.js";

export interface ContextObservation {
  readonly sessionId: string; readonly runId: string; readonly userTurnId: string; readonly stepId: string; readonly observedAt: string;
  readonly status: ContextProjection["status"]; readonly model: { readonly provider: string; readonly model: string };
  readonly instructions: readonly { readonly index: number; readonly role: string; readonly chars: number }[];
  readonly providers: readonly { readonly id: string; readonly items: readonly { readonly id: string; readonly kind: string; readonly placement: string; readonly included: boolean }[] }[];
  readonly messages: readonly { readonly index: number; readonly role: string; readonly chars: number; readonly toolNames: readonly string[] }[];
  readonly tools: readonly string[]; readonly budget: ContextProjection["budget"];
}
export type ContextObservationListener = (input: ContextInput, projection: ContextProjection) => void;

/** Decorates the existing algorithm through its public method; Core remains unaware of WebUI. */
export class ObservedContextProjector extends ContextProjector {
  constructor(services: ContextProjectorServices, private readonly observe?: ContextObservationListener) { super(services); }
  override async projectFromProviders<Input>(input: ContextProviderProjectionInput<Input>): Promise<ContextProjection> {
    const projection = await super.projectFromProviders(input);
    const facts = input.providerInput as Partial<ContextInput> | null;
    if (facts && typeof facts.sessionId === "string" && typeof facts.runId === "string" && typeof facts.stepId === "string" && typeof facts.userTurnId === "string") {
      try { this.observe?.(facts as ContextInput, projection); } catch { /* Observability cannot change request admission. */ }
    }
    return projection;
  }
}

/** Bounded metadata only; no instruction bodies, credentials or second transcript. */
export class ContextObservations {
  private readonly entries = new Map<string, ContextObservation>();
  record = (input: ContextInput, projection: ContextProjection): void => {
    const request = projection.status === "ready" ? projection.request : projection.candidateRequest;
    const included = new Set(projection.includedItems.map(item => item.id));
    const key = `${input.sessionId}/${input.runId}/${input.stepId}`;
    const observation = { sessionId: input.sessionId, runId: input.runId, userTurnId: input.userTurnId, stepId: input.stepId, observedAt: new Date().toISOString(), status: projection.status,
      model: request.model,
      instructions: request.instructions.map((instruction, index) => ({ index, role: instruction.role, chars: instruction.content.length })),
      providers: projection.providerGroups.map(group => ({ id: group.providerId, items: group.items.map(item => ({ id: item.id, kind: item.kind, placement: item.placement, included: included.has(item.id) })) })),
      messages: request.messages.map((message, index) => ({ index, role: message.role, chars: message.content.length, toolNames: (message.toolCalls ?? []).map(call => call.name) })),
      tools: request.tools.map(tool => tool.name), budget: { status: projection.budget.status,
        ...(projection.budget.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: projection.budget.estimatedInputTokens }),
        ...(projection.budget.inputLimitTokens === undefined ? {} : { inputLimitTokens: projection.budget.inputLimitTokens }) } };
    // An exceptionally large request must not turn the observer into an unbounded store.
    if (JSON.stringify(observation).length > 65536) return;
    this.entries.delete(key); this.entries.set(key, freeze(observation));
    while (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
  };
  list(sessionId: string): readonly ContextObservation[] { return Object.freeze([...this.entries.values()].filter(item => item.sessionId === sessionId)); }
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }
