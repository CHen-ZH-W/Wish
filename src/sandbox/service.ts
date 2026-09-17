import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  EffectiveSandboxCallPolicy,
  SandboxAuthorizationInput,
  SandboxPolicy,
  SandboxPolicyDescriptor,
  SandboxPreflightResult,
} from "./types.js";

/** Service Definition for approval-time provider-enforceability checks. */
export abstract class SandboxPolicyService extends Service
  implements SandboxPolicy {
  abstract readonly policy: SandboxPolicyDescriptor;

  constructor(ctx: Context) {
    super(ctx, "sandboxPolicy");
  }

  abstract preflight(
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> | SandboxPreflightResult;

  abstract revalidate(
    effective: EffectiveSandboxCallPolicy,
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> | SandboxPreflightResult;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sandboxPolicy: SandboxPolicyService;
  }
}

export default SandboxPolicyService;
