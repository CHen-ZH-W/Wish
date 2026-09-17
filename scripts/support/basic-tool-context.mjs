import { LocalFilesystemBackend } from
  "../../dist/filesystem/providers/local.js";
import { createUnavailableShell } from "../../dist/shell/index.js";

const capabilities = Object.freeze([
  "filesystem.read",
  "filesystem.write",
  "process.exec",
  "network.connect",
  "external.side_effect",
  "runtime.read",
  "runtime.control",
]);

/** Provider-neutral Step context for standalone Basic Tool tests. */
export function basicToolContext(cwd, options = {}) {
  const filesystem = options.filesystem ?? new LocalFilesystemBackend();
  const shell = options.shell ?? createUnavailableShell();
  const workspace = Object.freeze({
    requestedRoot: cwd,
    root: cwd,
    fingerprint: options.workspaceFingerprint ?? "workspace-1",
    revision: options.workspaceRevision ?? "workspace-revision-1",
    instructions: Object.freeze([]),
  });
  const permissions = Object.freeze({
    schemaVersion: 1,
    subject: Object.freeze({
      agentId: "agent",
      sessionId: "session",
      runId: "run",
      userTurnId: "turn",
      stepId: "step",
    }),
    profile: options.profile ?? "approval-required",
    availableTools: Object.freeze(["read", "write", "edit", "grep", "bash"]),
    ceiling: Object.freeze({ allowedCapabilities: capabilities }),
    workspace: Object.freeze({
      fingerprint: workspace.fingerprint,
      revision: workspace.revision,
    }),
    filesystemPolicyVersion: filesystem.policy.version,
    shellPolicyVersion: shell.policy.version,
    sandboxPolicyVersion: options.sandboxPolicyVersion ?? "sandbox-policy-1",
    policyVersion: options.policyVersion ?? "policy-1",
    authorityVersion: options.authorityVersion ?? "authority-1",
  });
  return Object.freeze({
    cwd,
    workspace,
    permissions,
    ...(options.modelSupportsImages === undefined
      ? {}
      : { modelSupportsImages: options.modelSupportsImages }),
  });
}
