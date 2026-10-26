import { Service, type Context } from "@deepseek-ai/cordis";

import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { WishApplication } from "../types.js";

export type WebUiControlStatus = 400 | 404 | 409 | 503;

/** Stable transport error authored by the control owner, not interpreted by WebUI Core. */
export class WebUiControlError extends Error {
  constructor(
    readonly status: WebUiControlStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebUiControlError";
  }
}

export interface WebUiControlStreamEvent {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
}

/** Host-selected default workspace; independent of any selected Session. */
export interface WebUiDefaultScope {
  readonly workspaceRoot: string;
}

/** Bounded domain adapter: no raw request/response access and no arbitrary routes. */
export interface WebUiControl {
  inspectDefault?(
    application: WishApplication,
    signal: AbortSignal,
    scope: WebUiDefaultScope,
  ): Promise<unknown> | unknown;
  /** Read-only default-scope query with a bounded owner-defined body. */
  queryDefault?(
    application: WishApplication,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    scope: WebUiDefaultScope,
  ): Promise<unknown> | unknown;
  updateDefault?(
    application: WishApplication,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    scope: WebUiDefaultScope,
  ): Promise<unknown> | unknown;
  inspectSession?(
    application: WishApplication,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<unknown> | unknown;
  /** Read-only operation with a bounded owner-defined request body. */
  querySession?(
    application: WishApplication,
    sessionId: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> | unknown;
  updateSession?(
    application: WishApplication,
    sessionId: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> | unknown;
  /** Owner-defined, bounded Session stream transported as SSE by WebUI Core. */
  streamSession?(
    application: WishApplication,
    sessionId: string,
    query: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): AsyncIterable<WebUiControlStreamEvent>;
}

export interface WebUiControlResolver {
  get(key: string): WebUiControl | undefined;
}

export class WebUiControlRegistry implements WebUiControlResolver {
  private readonly controls = new Map<string, WebUiControl>();

  register(key: string, control: WebUiControl): () => void {
    const id = controlKey(key);
    if (this.controls.has(id)) throw new Error(`WebUI control already registered: ${id}`);
    if (!control.inspectDefault && !control.queryDefault && !control.updateDefault && !control.inspectSession && !control.querySession && !control.updateSession && !control.streamSession) {
      throw new Error(`WebUI control has no operations: ${id}`);
    }
    this.controls.set(id, control);
    return () => { if (this.controls.get(id) === control) this.controls.delete(id); };
  }

  get(key: string): WebUiControl | undefined {
    return this.controls.get(controlKey(key));
  }
}

/** Cordis registration surface; individual domain adapters retain their own lifecycle. */
export class WebUiControls extends Service implements WebUiControlResolver {
  private readonly registry = new WebUiControlRegistry();
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "webUiControls");
    this.work = new PluginWorkOwner(ctx, { code: "webui_controls", codeReload: true });
  }

  register(key: string, control: WebUiControl): () => void {
    this.work.assertAttached();
    return this.registry.register(key, control);
  }

  get(key: string): WebUiControl | undefined {
    this.work.assertAttached();
    return this.registry.get(key);
  }
}

/** Bind one control and all admitted calls to the registering plugin Fiber. */
export function registerManagedWebUiControl(
  ctx: Context,
  key: string,
  control: WebUiControl,
): void {
  let unregister = () => {};
  const work = new PluginWorkOwner(ctx, {
    code: "webui_control",
    codeReload: true,
    close: () => { unregister(); },
  });
  unregister = ctx.webUiControls.register(key, {
    ...(control.inspectDefault ? {
      inspectDefault: (application, signal, scope) => work.run(() => control.inspectDefault!(application, signal, scope)),
    } : {}),
    ...(control.queryDefault ? {
      queryDefault: (application, body, signal, scope) => work.run(() => control.queryDefault!(application, body, signal, scope)),
    } : {}),
    ...(control.updateDefault ? {
      updateDefault: (application, body, signal, scope) => work.run(() => control.updateDefault!(application, body, signal, scope)),
    } : {}),
    ...(control.inspectSession ? {
      inspectSession: (application, sessionId, signal) => work.run(() => control.inspectSession!(application, sessionId, signal)),
    } : {}),
    ...(control.querySession ? {
      querySession: (application, sessionId, body, signal) => work.run(() => control.querySession!(application, sessionId, body, signal)),
    } : {}),
    ...(control.updateSession ? {
      updateSession: (application, sessionId, body, signal) => work.run(() => control.updateSession!(application, sessionId, body, signal)),
    } : {}),
    ...(control.streamSession ? {
      streamSession: (application, sessionId, query, signal) => work.stream(() => control.streamSession!(application, sessionId, query, signal)),
    } : {}),
  });
}

function controlKey(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(value)) {
    throw new Error("Invalid WebUI control key");
  }
  return value;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    webUiControls: WebUiControls;
  }
}

export default WebUiControls;
