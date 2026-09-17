import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  CaptureTmuxPaneRequest,
  ListTmuxSessionsRequest,
  SendTmuxKeysRequest,
  StartTmuxSessionRequest,
  StopTmuxSessionRequest,
  Tmux,
  TmuxSessionSnapshot,
  TmuxTarget,
} from "./types.js";

/** Service Definition implemented by one transparent tmux Provider. */
export abstract class TmuxService extends Service implements Tmux {
  constructor(ctx: Context) {
    super(ctx, "tmux");
  }

  abstract start(request: StartTmuxSessionRequest): Promise<TmuxSessionSnapshot>;
  abstract list(request?: ListTmuxSessionsRequest): Promise<readonly TmuxSessionSnapshot[]>;
  abstract inspect(
    target: TmuxTarget,
    signal?: AbortSignal,
  ): Promise<TmuxSessionSnapshot | undefined>;
  abstract capture(request: CaptureTmuxPaneRequest): Promise<string>;
  abstract send(request: SendTmuxKeysRequest): Promise<void>;
  abstract stop(request: StopTmuxSessionRequest): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tmux: TmuxService;
  }
}

export default TmuxService;
