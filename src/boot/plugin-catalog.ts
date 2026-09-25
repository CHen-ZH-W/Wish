import { registerHooks } from "node:module";
import type { Context } from "@deepseek-ai/cordis";
import { PluginManagementClassifier, type DeclaredPluginManagementClass } from "./plugin-control/classification.js";

/** Host capability entrypoints; declarations do not import implementations. */
export const HOST_PLUGIN_CATALOG = Object.freeze({
  "include": "@deepseek-ai/cordis-plugin-include",
  "group": "@deepseek-ai/cordis-plugin-group",
  "timer": "@deepseek-ai/cordis-plugin-timer",
  "hmr": "@deepseek-ai/cordis-plugin-hmr",
  "storage": "../storage/service.js",
  "storage-file": "../storage/providers/file/plugin.js",
  "runtime-lifecycle-journal": "../core/runtime/durability/providers/journal.js",
  "model-catalog-storage": "../models/persistence/storage-provider.js",
  "model-attempt-ledger-storage": "../models/pricing/providers/storage.js",
  "tool-result-archive-blob": "../tools/results/providers/blob.js",
  "tool-output-artifacts-blob": "../tools/results/artifacts/providers/blob.js",
  "session-file": "../sessions/providers/file/plugin.js",
  "sessions": "../sessions/service.js",
  "workspace-local": "../workspace/providers/local.js",
  "skills-local": "../skills/providers/local.js",
  "skills-context": "../skills/consumers/context.js",
  "skills-session-feature": "../skills/consumers/session-feature.js",
  "skills-plan-controls": "../skills/consumers/skills-plan-controls-entry.js",
  "skills-coordinator-controls": "../skills/consumers/skills-coordinator-controls-entry.js",
  "memory-storage": "../memory/providers/storage.js",
  "memory-child-snapshot": "../memory/providers/child-snapshot.js",
  "memory-curation": "../memory/providers/curation.js",
  "memory-context": "../memory/consumers/context.js",
  "memory-session-feature": "../memory/consumers/session-feature.js",
  "memory-plan-controls": "../memory/consumers/memory-plan-controls-entry.js",
  "memory-coordinator-controls": "../memory/consumers/memory-coordinator-controls-entry.js",
  "memory-subagent-resources": "../memory/consumers/subagent-resources.js",
  "memory-runtime-evidence": "../memory/consumers/runtime-evidence.js",
  "memory-workflow-evidence": "../memory/consumers/workflow-evidence.js",
  "filesystem-local": "../filesystem/providers/local.js",
  "filesystem-search-local": "../filesystem/search/providers/local.js",
  "shell-linux-native": "../shell/providers/linux-native.js",
  "shell-host": "../shell/providers/host.js",
  "tmux-local": "../tmux/providers/local.js",
  "subagent-execution-tmux": "../subagents/providers/tmux-execution.js",
  "subagent-launcher-cli": "../apps/cli/subagent-launcher.js",
  "subagents-runtime": "../subagents/runtime.js",
  "subagents-session-feature": "../subagents/consumers/session-feature.js",
  "tmux-session-feature": "../tmux/consumers/session-feature.js",
  "context-session-feature": "../context/consumers/session-feature.js",
  "approval-hub": "../approval/service.js",
  "approval-rules-storage": "../permissions/rules/providers/storage.js",
  "sandbox-policy-default": "../sandbox/providers/default.js",
  "permissions-default": "../permissions/providers/default.js",
  "plan-storage": "../plan/providers/storage.js",
  "plan-mode-adapters": "../plan/consumers/mode-adapters.js",
  "plan-session-feature": "../plan/consumers/session-feature.js",
  "tasks-storage": "../tasks/providers/storage.js",
  "tasks-session-feature": "../tasks/consumers/session-feature.js",
  "workflow-storage": "../workflow/providers/storage.js",
  "workflow-continuations": "../workflow/providers/continuations.js",
  "workflow-schedulers": "../workflow/providers/schedulers.js",
  "workflow-graph-scheduler": "../workflow/providers/graph-scheduler.js",
  // Compatibility alias: this is now a dispatch strategy adapter, not a Tool Consumer.
  "workflow-subagent-tools": "../workflow/consumers/subagent-tools.js",
  "workflow-session-feature": "../workflow/consumers/session-feature.js",
  "workflow-plan-controls": "../workflow/consumers/workflow-plan-controls-entry.js",
  "tasks-plan-controls": "../tasks/consumers/plan-controls.js",
  "workflow-coordinator-controls": "../workflow/consumers/workflow-coordinator-controls-entry.js",
  "coordinator-storage": "../coordinator/providers/storage.js",
  "coordinator-mode-adapters": "../coordinator/consumers/mode-adapters.js",
  "web-fetch-http": "../web/providers/http-fetch.js",
  "web-search-searxng": "../web/providers/searxng-search.js",
  "models": "../models/service.js",
  "model-openai-chat-completions": "../models/model-openai-chat-completions-entry.js",
  "model-openai-responses": "../models/model-openai-responses-entry.js",
  "model-anthropic-messages": "../models/model-anthropic-messages-entry.js",
  "context-engine": "../context/service.js",
  "system-prompt": "../system-prompt/service.js",
  "system-prompt-base": "../system-prompt/consumers/base.js",
  "system-prompt-context": "../system-prompt/consumers/context.js",
  "compaction": "../compaction/service.js",
  "tools": "../tools/service.js",
  "agent-loop": "../composition/agent-loop-service.js",
  "runtime": "../composition/runtime-service.js",
  "agents": "../composition/agent-service.js",
  "application": "../apps/service.js",
  "cli": "../apps/cli/plugin.js",
  "webui": "../apps/webui/plugin.js",
});

/** Optional model control surfaces, separate from their capability Providers. */
export const MODEL_TOOL_PLUGIN_CATALOG = Object.freeze({
  "read": "../filesystem/consumers/model-tools/read-entry.js",
  "filesystem-tool-guidance": "../filesystem/consumers/model-tools/guidance.js",
  "write": "../filesystem/consumers/model-tools/write-entry.js",
  "edit": "../filesystem/consumers/model-tools/edit-entry.js",
  "grep": "../filesystem/search/consumers/grep-entry.js",
  "bash": "../shell/consumers/bash-entry.js",
  "bash-tool-guidance": "../shell/consumers/guidance.js",
  "subagent-tools": "../subagents/consumers/model-tools/plugin.js",
  "subagent-tool-guidance": "../subagents/consumers/model-tools/guidance.js",
  "plan-tools": "../plan/consumers/model-tools/plugin.js",
  "task-tools": "../tasks/consumers/model-tools.js",
  "task-update-tool": "../tasks/consumers/task-update-tool.js",
  "workflow-tools": "../workflow/consumers/model-tools.js",
  "workflow-control-tools": "../workflow/consumers/workflow-control-tools.js",
  "workflow-start-tool": "../workflow/consumers/workflow-start-tool.js",
  "coordinator-tools": "../coordinator/consumers/model-tools/plugin.js",
  "web-fetch-tool": "../web/web-fetch-tool-entry.js",
  "web-search-tool": "../web/web-search-tool-entry.js",
  "web-tool-guidance": "../web/guidance.js",
  "skills-tools": "../skills/consumers/model-tools.js",
  "memory-read-tools": "../memory/consumers/memory-read-tools-entry.js",
  "memory-write-tool": "../memory/consumers/memory-write-tool-entry.js",
});

/**
 * Explicit Host authority metadata. Catalog membership means managed unless an
 * entry is named here as process infrastructure or a structural carrier.
 * The values are keyed by Loader alias, never inferred from an Entry id.
 */
export const HOST_PLUGIN_MANAGEMENT = Object.freeze({
  ...Object.fromEntries(Object.keys(HOST_PLUGIN_CATALOG).map(alias => [alias, "managed" as const])),
  include: "kernel",
  group: "structural",
  timer: "kernel",
  hmr: "kernel",
}) as Readonly<Record<keyof typeof HOST_PLUGIN_CATALOG, DeclaredPluginManagementClass>>;

export const MODEL_TOOL_PLUGIN_MANAGEMENT = Object.freeze(
  Object.fromEntries(Object.keys(MODEL_TOOL_PLUGIN_CATALOG).map(alias => [alias, "managed" as const])),
) as Readonly<Record<keyof typeof MODEL_TOOL_PLUGIN_CATALOG, "managed">>;

export function createWishPluginManagementClassifier(): PluginManagementClassifier {
  const declarations: Record<string, DeclaredPluginManagementClass> = { "cordis:wish-managed-profile": "kernel" };
  for (const [alias, managementClass] of Object.entries({ ...HOST_PLUGIN_MANAGEMENT, ...MODEL_TOOL_PLUGIN_MANAGEMENT })) {
    declarations[`cordis:${alias}`] = managementClass;
  }
  for (const [alias, specifier] of Object.entries(HOST_PLUGIN_CATALOG)) {
    if (!specifier.startsWith(".")) declarations[specifier] = HOST_PLUGIN_MANAGEMENT[alias as keyof typeof HOST_PLUGIN_CATALOG];
  }
  return new PluginManagementClassifier(declarations);
}

/** Resolve both Loader aliases and HMR's Node module graph to the same identity. */
export function installWishPluginCatalog(root: Context): void {
  const entries = Object.entries({ ...HOST_PLUGIN_CATALOG, ...MODEL_TOOL_PLUGIN_CATALOG });
  const urls = new Map(entries.map(([name, specifier]) => [
    "cordis:" + name,
    specifier.startsWith(".") ? new URL(specifier, import.meta.url).href : import.meta.resolve(specifier),
  ]));
  root.effect(() => {
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(urls.get(specifier) ?? specifier, context);
      },
    });
    return () => hook.deregister();
  }, "Wish plugin module aliases");
  for (const [name] of entries) {
    const url = urls.get("cordis:" + name)!;
    Object.defineProperty(root.loader.builtins, name, {
      configurable: true,
      enumerable: true,
      // Do not retain an import promise: re-enabling after HMR must see the new cache.
      get: () => root.loader.import(url),
      // Embeddings may explicitly replace a builtin; never rewrite deployment identity.
      set: value => Object.defineProperty(root.loader.builtins, name, {
        value, writable: true, configurable: true, enumerable: true,
      }),
    });
  }
}
