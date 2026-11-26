export interface InteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}
export interface InteractionQuestion {
  readonly id: string;
  readonly question: string;
  readonly why?: string;
  readonly multiple?: boolean;
  readonly options?: readonly InteractionOption[];
}
export interface InteractionInput {
  readonly title: string;
  readonly description?: string;
  readonly questions: readonly InteractionQuestion[];
}
export interface InteractionAnswer {
  readonly questionId: string;
  readonly optionIds: readonly string[];
  readonly text: string;
}
export type InteractionStatus = "pending" | "answered" | "dismissed" | "interrupted";
export interface ConversationInteraction extends InteractionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly status: InteractionStatus;
  readonly answers?: readonly InteractionAnswer[];
  readonly resolvedAt?: string;
  readonly reason?: string;
}
export interface InteractionState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly requests: readonly ConversationInteraction[];
}
export interface InteractionStore {
  get(sessionId: string): Promise<InteractionState | undefined>;
  list(): Promise<readonly InteractionState[]>;
  put(state: InteractionState, expectedRevision: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
export interface OpenInteraction extends InteractionInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
}
export interface RespondInteraction {
  readonly requestId: string;
  readonly revision: number;
  readonly answers?: readonly InteractionAnswer[];
  readonly dismiss?: boolean;
}
