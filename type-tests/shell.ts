import type { Fiber } from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";

import type { ToolAuthorizationGrant } from
  "../src/core/tools/authorization.js";
import type { Filesystem } from "../src/filesystem/index.js";
import HostShell, { HostShellBackend } from
  "../src/shell/providers/host.js";
import LinuxNativeShell, { LinuxNativeShellBackend } from
  "../src/shell/providers/linux-native.js";
import type {
  Shell,
  ShellCommandPreflight,
  ShellExecutionContext,
  ShellExecutionResult,
} from "../src/shell/index.js";

declare const executionContext: ShellExecutionContext;
declare const filesystem: Filesystem;
declare const grant: ToolAuthorizationGrant;

const root = new Context();
const nativeFiber: Fiber = root.plugin(LinuxNativeShell, {
  maxProcesses: 64,
});
const hostFiber: Fiber = root.plugin(HostShell, { enabled: true });
const native: Shell = new LinuxNativeShellBackend(filesystem);
const host: Shell = new HostShellBackend(filesystem, { enabled: true });

const preflight: Promise<ShellCommandPreflight> = native.preflight({
  command: "printf ok",
  capabilities: {
    requirements: [{
      capability: "process.exec",
      commands: ["printf ok"],
    }],
  },
  context: executionContext,
});

async function execute(shell: Shell): Promise<ShellExecutionResult> {
  const spec = await shell.resolve({
    command: "printf ok",
    context: executionContext,
    grant,
  });
  return await shell.run({ spec, onData() {} });
}

void nativeFiber;
void hostFiber;
void native;
void host;
void preflight;
void execute;
