import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  TitleAcceptedInput, TitleGenerationInput, TitleGenerationResult, TitleGenerator, TitleJob,
} from "./types.js";

/** Replaceable model-independent title generation capability. */
export abstract class SessionTitleGeneratorService extends Service implements TitleGenerator {
  constructor(ctx: Context) { super(ctx, "sessionTitleGenerator"); }
  abstract generate(input: TitleGenerationInput): Promise<TitleGenerationResult>;
}

/** Durable scheduling and title acceptance; it does not own conversation history. */
export abstract class SessionTitleService extends Service {
  constructor(ctx: Context) { super(ctx, "sessionTitle"); }
  abstract accept(input: TitleAcceptedInput): Promise<void>;
  abstract resume(): Promise<void>;
  abstract inspect(sessionId: string): Promise<TitleJob | undefined>;
  abstract cancel(sessionId: string): Promise<void>;
  abstract purge(sessionId: string): Promise<void>;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionTitle: SessionTitleService;
    sessionTitleGenerator: SessionTitleGeneratorService;
  }
}
