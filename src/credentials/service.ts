import { Service, type Context } from "@deepseek-ai/cordis";
import { Credentials } from "./credentials.js";
import type { CredentialStore, CredentialsPort } from "./types.js";

declare module "@deepseek-ai/cordis" { interface Context { credentials: CredentialsService } }

/** Stable process infrastructure; capability consumers resolve named values through it. */
export class CredentialsService extends Service {
  readonly port: CredentialsPort;
  constructor(
    ctx: Context,
    store: CredentialStore,
    environment: Readonly<Record<string, string | undefined>>,
  ) {
    super(ctx, "credentials");
    this.port = new Credentials(store, environment);
    ctx.effect(() => () => this.port.close(), "credentials persistence");
  }

  resolve(reference: string): string | undefined { return this.port.resolve(reference); }
}
