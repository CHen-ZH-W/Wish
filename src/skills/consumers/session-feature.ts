import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionFeature } from "../../apps/session-features.js";
import { skillName } from "../markdown.js";
import type { SkillSummary, Skills } from "../types.js";
import { SkillOwnerLifecycle } from "../lifecycle.js";
import type { SkillFeatureData, SkillFeatureEntry } from "../presentation.js";

/** Host-owned Session/Workspace facts, not model-selected cwd or Session files. */
export interface SkillSessionWorkspace {
  resolve(sessionId: string): Promise<{ readonly cwd: string; readonly fingerprint: string; readonly revision: string }>;
}

/** Human browsing only. A displayed Skill is NOT a Session activation. */
export function createSkillSessionFeature(skills: Skills, workspaces: SkillSessionWorkspace): SessionFeature {
  // Bounded ephemeral UI selection; content is reloaded and revalidated on inspect.
  const viewed = new Map<string, Pick<SkillSummary, "name" | "digest" | "packageId">>();
  async function current(sessionId: string) {
    const workspace = await workspaces.resolve(sessionId);
    const catalog = await skills.list({ cwd: workspace.cwd });
    const reviewId = createHash("sha256").update(JSON.stringify({ sessionId, workspace, skills: catalog.skills })).digest("hex");
    return { workspace, catalog, reviewId };
  }
  return {
    async inspect(sessionId) {
      const { workspace, catalog, reviewId } = await current(sessionId);
      const lines = ["查看只向人类展示正文，不会激活 Skill、改变模型权限或执行脚本。", "选择“查看 Skill”，填写下列准确名称：",
        ...catalog.skills.map(skill => `${skill.name} [${skill.source}; ${skill.modelInvocable ? "模型可按需加载" : "仅 Host 显式读取"}] ${JSON.stringify(skill.description)}`),
        ...(catalog.issues.length ? [`目录诊断：${JSON.stringify(catalog.issues)}`] : []),
      ];
      const selected = viewed.get(sessionId);
      let selectedData: SkillFeatureData["selected"], selectionChanged = false;
      if (selected) {
        const live = catalog.skills.find(skill => skill.name === selected.name && skill.digest === selected.digest && skill.packageId === selected.packageId);
        if (!live) { selectionChanged = true; lines.push("上次查看的 Skill 已变化或不可用，请重新选择目录中的版本。"); }
        else {
          const resource = await skills.read({ cwd: workspace.cwd, name: selected.name, expectedDigest: selected.digest, expectedPackageId: selected.packageId, invocation: "host" });
          lines.push(`\n正在查看 ${selected.name} (${selected.digest})\n${resource.content}`);
          selectedData = Object.freeze({ entry: presentSkill(live), content: resource.content });
        }
      }
      const data: SkillFeatureData = Object.freeze({ schemaVersion: 1,
        workspace: Object.freeze({ fingerprint: workspace.fingerprint, revision: workspace.revision }),
        skills: Object.freeze(catalog.skills.map(presentSkill)),
        issues: Object.freeze(catalog.issues.map(issue => Object.freeze({ location: issue.location, message: issue.message }))),
        ...(selectedData ? { selected: selectedData } : {}), selectionChanged });
      return { key: "skills", title: "Skill 目录与正文查看", titleEn: "Skill catalog and instructions", text: lines.join("\n"), token: { reviewId },
        data,
        actions: catalog.skills.length ? [{ name: "inspect", label: "查看 Skill（填写名称）", labelEn: "View Skill (enter name)", feedback: true }] : [] };
    },
    async act(sessionId, action, token, feedback) {
      if (action !== "inspect") throw new Error("Unknown Skill viewing action; activation is not supported");
      const name = skillName(feedback?.trim());
      const { workspace, catalog, reviewId } = await current(sessionId);
      if (token.reviewId !== reviewId) throw new Error("Skill catalog or Session Workspace changed; inspect the current catalog first");
      const selected = catalog.skills.find(skill => skill.name === name);
      if (!selected) throw new Error("Skill is not present in the displayed catalog");
      // Read completely before accepting the browsing selection. Disabled model
      // invocation is allowed only here, on the human SessionFeature surface.
      await skills.read({ cwd: workspace.cwd, name, expectedDigest: selected.digest, expectedPackageId: selected.packageId, invocation: "host" });
      viewed.delete(sessionId);
      viewed.set(sessionId, { name, digest: selected.digest, packageId: selected.packageId });
      if (viewed.size > 100) viewed.delete(viewed.keys().next().value!);
    },
  };
}

function presentSkill(skill: SkillSummary): SkillFeatureEntry {
  return Object.freeze({ packageId: skill.packageId, name: skill.name, description: skill.description,
    source: skill.source, digest: skill.digest, modelInvocable: skill.modelInvocable });
}

export const SkillsSessionFeature = {
  name: "skills-session-feature", inject: ["application", "skills", "sessions", "workspace", "agents"],
  apply(ctx: Context): void {
    const owner = new SkillOwnerLifecycle(ctx);
    const feature = createSkillSessionFeature(ctx.skills, {
      async resolve(sessionId) {
        const session = await ctx.sessions.manager.get({ sessionId });
        if (session.agentId !== ctx.agents.agentId || session.status !== "active") throw new Error("Skill viewing requires an active owned Session");
        const workspace = await ctx.workspace.resolve({ root: session.scope });
        return { cwd: workspace.root, fingerprint: workspace.fingerprint, revision: workspace.revision };
      },
    });
    owner.own(ctx.application.registerSessionFeature("skills", {
      inspect: (...args) => owner.run(() => feature.inspect(...args)),
      act: (...args) => owner.run(() => feature.act(...args)),
    }));
  },
};
export default SkillsSessionFeature;
