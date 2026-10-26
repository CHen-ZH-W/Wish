import type { Context } from "@deepseek-ai/cordis";
import { AgentScope } from "../../composition/agent-scope.js";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { canDelegatePermissionProfile } from "../../permissions/delegation.js";
import { captureComposition, verifyCode } from "../composition.js";
import { AgentProfileError, digest, verifyRuntime } from "../validation.js";
import type { ApplicationExecutionProfile } from "../../apps/execution-profile.js";
import { captureProfileResources } from "../resources.js";
import ProfileSkills from "../resource-skills.js";
import ProfileMemory from "../resource-memory.js";

/** Composition adapter; neither Application nor Core Runtime depends on Profile storage. */
export default {
  name: "agent-profile-application", inject: ["launch", "application", "agentProfiles", "agents", "compaction", "models", "modelAttemptLedger", "permissions", "tools", "systemPrompt", "contextEngine"],
  apply(ctx: Context) {
    const scopes = new Set<AgentScope>();
    const runtimes = new Map<AgentScope, () => Promise<void>>();
    let closing = false;
    const work = new PluginWorkOwner(ctx, { code: "agent_profile_application", codeReload: true,
      beforeDrain: () => { closing = true; },
      close: async () => {
        await Promise.all([...runtimes.values()].map(retire => retire()));
        await Promise.all([...scopes].map(scope => scope.dispose()));
      },
    });
    const unregister = ctx.application.registerExecutionProfiles({
      open: (selection, configuration, credential) => work.run(async () => {
        const snapshot = await ctx.agentProfiles.capture(selection, configuration);
        if (snapshot.candidate && !(ctx.launch.environment.WISH_EXPERIMENT_WORKER === "1" && ctx.launch.environment.WISH_CANDIDATE_WORKER === "1")) throw new AgentProfileError("profile_candidate_requires_sandbox");
        verifyRuntime(snapshot);
        await verifyCode(snapshot.code);
        const parent = ctx.agents.permissions;
        if (!canDelegatePermissionProfile(parent.profile ?? ctx.permissions.defaultProfile ?? "approval-required", snapshot.definition.permissionProfile)) throw new AgentProfileError("profile_permission_escalation");
        if (snapshot.definition.tools.some(name => !ctx.tools.registryFor(ctx.agents.scope).has(name) || (parent.availableTools && !parent.availableTools.includes(name)))) throw new AgentProfileError("profile_tool_unavailable");
        if (snapshot.permissions.allowedCapabilities?.some(kind => parent.allowedCapabilities && !parent.allowedCapabilities.includes(kind))) throw new AgentProfileError("profile_capability_escalation");
        const worker = ctx.launch.environment.WISH_EXPERIMENT_WORKER === "1";
        if (snapshot.definition.memory === "isolated" && !worker) throw new AgentProfileError("profile_memory_requires_isolated_host", "This Profile's Memory requires an isolated experiment Host");
        if (snapshot.resources && !worker) throw new AgentProfileError("profile_resources_require_isolated_host");
        const current = captureComposition(ctx);
        if (!worker && digest(current.plugins) !== digest(snapshot.plugins)) throw new AgentProfileError("profile_composition_mismatch", "The current deployment differs from the frozen Profile");
        const scope = new AgentScope(`profile:${snapshot.digest}`, ctx.agents.scope);
        scopes.add(scope);
        let compactor: ApplicationExecutionProfile["compactor"];
        try {
          ctx.compaction.selectScoped(ctx, scope, snapshot.compaction);
          // Resolve the selected Provider now; a miss is an admission failure.
          compactor = ctx.compaction.open({ agentScope: scope, dataDirectory: configuration.dataDirectory,
            models: ctx.models.open(snapshot.models, { fixedConfiguration: true,
              ...(credential === undefined ? {} : { credential }),
              attemptLedger: { ledger: ctx.modelAttemptLedger, currency: ctx.modelAttemptLedger.currency },
            }), keepRecentTokens: snapshot.compaction.keepRecentTokens,
            summaryMaxOutputTokens: snapshot.compaction.summaryMaxOutputTokens });
        } catch (error) { scopes.delete(scope); await scope.dispose(); throw error; }
        const toolRegistry = ctx.tools.registryFor(scope);
        const toolVersion = toolRegistry.version;
        const contextVersion = ctx.contextEngine.providerVersion;
        const modelVersion = ctx.models.registry.version;
        const assertCurrent = async () => {
          if (closing || scope.isClosing) throw new AgentProfileError("profile_execution_closed");
          if (captureComposition(ctx).identity !== current.identity) throw new AgentProfileError("profile_runtime_changed", "The bound plugin generation changed; start a new Run with an explicit Profile snapshot");
          if (toolRegistry.version !== toolVersion || ctx.contextEngine.providerVersion !== contextVersion || ctx.models.registry.version !== modelVersion) throw new AgentProfileError("profile_contributions_changed");
          await verifyCode(snapshot.code);
          if (snapshot.resources) {
            const skills = ctx.get("skills"), memory = ctx.get("memory");
            if (skills && !(skills instanceof ProfileSkills) || memory && (!(memory instanceof ProfileMemory) || memory.initialStateDigest !== digest(snapshot.resources.memory))) throw new AgentProfileError("profile_frozen_resource_provider_required");
            const resources = await captureProfileResources({ cwd: ctx.launch.cwd, skills: ctx.get("skills"), emptySkills: !ctx.get("skills"), memory: snapshot.resources.memory });
            if (resources.digest !== snapshot.resources.digest) throw new AgentProfileError("profile_runtime_resources_changed");
          }
        };
        try { await assertCurrent(); }
        catch (error) { scopes.delete(scope); await scope.dispose(); throw error; }
        const profile: ApplicationExecutionProfile = {
          identity: Object.freeze({ id: snapshot.definition.id, version: snapshot.definition.version, digest: snapshot.digest }),
          model: snapshot.model,
          ...(snapshot.definition.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.definition.reasoningEffort }),
          permissionProfile: snapshot.definition.permissionProfile,
          models: snapshot.models, scope, permissions: snapshot.permissions, instructions: snapshot.instructions,
          promptSections: snapshot.promptSections, reservedOutputTokens: snapshot.reservedOutputTokens,
          keepRecentTokens: snapshot.compaction.keepRecentTokens, summaryMaxOutputTokens: snapshot.compaction.summaryMaxOutputTokens,
          maxParallelCalls: snapshot.maxParallelCalls,
          ...(snapshot.definition.request === undefined ? {} : { request: snapshot.definition.request }),
          excludedContextProviders: snapshot.definition.memory === "none" ? ["memory-index"] : [],
          compactor,
          assertCurrent,
          async admit(sessionId, runId) { await assertCurrent(); await ctx.agentProfiles.bind(snapshot.digest, sessionId, runId); },
          finish: (runId, status) => ctx.agentProfiles.finish(runId, status),
          async release() { scopes.delete(scope); runtimes.delete(scope); await scope.dispose(); },
          attachRuntime(retire) { runtimes.set(scope, retire); },
        };
        return Object.freeze(profile);
      }),
    });
    ctx.effect(() => unregister, "Application execution Profiles");
  },
};
