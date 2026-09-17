import { Context, type Fiber } from "@deepseek-ai/cordis";

import type { Filesystem } from "../src/filesystem/index.js";
import type { Shell } from "../src/shell/index.js";
import {
  DefaultSandboxPolicyBackend,
} from "../src/sandbox/providers/default.js";
import DefaultSandboxPolicy from
  "../src/sandbox/providers/default.js";
import type {
  EffectiveSandboxCallPolicy,
  SandboxAuthorizationInput,
  SandboxPolicy,
  SandboxPreflightResult,
} from "../src/sandbox/index.js";

declare const filesystem: Filesystem;
declare const shell: Shell;
declare const input: SandboxAuthorizationInput;
declare const effective: EffectiveSandboxCallPolicy;

const backend: SandboxPolicy = new DefaultSandboxPolicyBackend(
  filesystem,
  shell,
);
const preflight: Promise<SandboxPreflightResult> = Promise.resolve(
  backend.preflight(input),
);
const revalidated: Promise<SandboxPreflightResult> = Promise.resolve(
  backend.revalidate(effective, input),
);
const ctx = new Context();
const fiber: Fiber = ctx.plugin(DefaultSandboxPolicy);

void preflight;
void revalidated;
void fiber;
