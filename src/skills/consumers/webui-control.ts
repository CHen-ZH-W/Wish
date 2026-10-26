import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl, WebUiControlError, type WebUiControl } from "../../apps/webui/controls.js";
import type { WorkspaceResolver } from "../../workspace/types.js";
import { SkillImportError, skillCatalogDigest } from "../import.js";
import type { SkillImportFile } from "../import-types.js";
import type { SkillFeatureEntry } from "../presentation.js";
import type { SkillsService } from "../service.js";
import type { SkillSummary } from "../types.js";
import type { SkillDocumentView, SkillImportView, SkillsLibraryView } from "./webui-types.js";

export const SKILLS_WEBUI_CONTROL = "skills";

/** Host-owned library browsing and import; no Session or model-tool authority. */
export function createSkillsWebUiControl(skills: SkillsService, workspaces: WorkspaceResolver): WebUiControl {
  async function library(root: string, signal: AbortSignal): Promise<SkillsLibraryView> {
    const workspace = await workspaces.resolve({ root, signal });
    const catalog = await skills.list({ cwd: workspace.root, signal });
    const capabilities = skills.importCapabilities();
    return Object.freeze({ schemaVersion: 1,
      workspace: Object.freeze({ root: workspace.root, fingerprint: workspace.fingerprint, revision: workspace.revision }),
      catalogDigest: skillCatalogDigest(catalog), skills: Object.freeze(catalog.skills.map(present)),
      issues: Object.freeze(catalog.issues.map(issue => Object.freeze({ ...issue }))),
      ...(capabilities ? { import: capabilities } : {}),
    });
  }

  return Object.freeze({
    inspectDefault(_application, signal, scope) { return translate(() => library(scope.workspaceRoot, signal)); },
    queryDefault(_application, body, signal, scope) {
      return translate(async (): Promise<SkillDocumentView> => {
        onlyKeys(body, ["name", "expectedDigest", "expectedPackageId"]);
        const workspace = await workspaces.resolve({ root: scope.workspaceRoot, signal });
        const resource = await skills.read({ cwd: workspace.root, signal, invocation: "host",
          name: field(body, "name", 64), expectedDigest: field(body, "expectedDigest", 256),
          expectedPackageId: field(body, "expectedPackageId", 256) });
        if (!resource.complete || resource.offset !== 0 || resource.path !== "SKILL.md") {
          throw new WebUiControlError(503, "skill_document_incomplete", "Skill 正文未完整读取，请重新打开目录。");
        }
        return Object.freeze({ schemaVersion: 1, entry: present(resource.skill), content: resource.content });
      });
    },
    updateDefault(_application, body, signal, scope) {
      return translate(async (): Promise<SkillImportView> => {
        onlyKeys(body, ["files", "expectedCatalogDigest", "overwrite"]);
        if (!skills.importCapabilities()) throw new WebUiControlError(503, "skill_import_unavailable", "当前 Skills Provider 不支持手动导入。");
        if (typeof body.overwrite !== "boolean") throw new WebUiControlError(400, "invalid_request", "请选择是否覆盖同名 Skill。");
        const files = importFiles(body.files);
        const workspace = await workspaces.resolve({ root: scope.workspaceRoot, signal });
        const imported = await skills.importPackage({ cwd: workspace.root, signal, files,
          expectedCatalogDigest: field(body, "expectedCatalogDigest", 256), overwrite: body.overwrite });
        let catalog: SkillsLibraryView;
        try { catalog = await library(workspace.root, signal); }
        catch {
          throw new WebUiControlError(503, "skill_import_refresh_required", "Skill 已导入，但目录读取失败。请刷新核对结果，不要重复导入。");
        }
        return Object.freeze({ schemaVersion: 1, catalog, imported: present(imported) });
      });
    },
  } satisfies WebUiControl);
}

function present(skill: SkillSummary): SkillFeatureEntry {
  return Object.freeze({ packageId: skill.packageId, name: skill.name, description: skill.description,
    source: skill.source, digest: skill.digest, modelInvocable: skill.modelInvocable });
}

function onlyKeys(body: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new WebUiControlError(400, "invalid_request", "Skill 请求包含不支持的字段。");
}

function field(body: Readonly<Record<string, unknown>>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max) throw new WebUiControlError(400, "invalid_request", `Skill 请求字段 ${key} 无效。`);
  return value;
}

function importFiles(value: unknown): readonly SkillImportFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) throw new WebUiControlError(400, "invalid_request", "请选择一个 Skill 文件夹或 SKILL.md 文件。");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new WebUiControlError(400, "invalid_request", "Skill 文件内容无效。");
    const file = item as Record<string, unknown>;
    onlyKeys(file, ["path", "content"]);
    if (typeof file.content !== "string") throw new WebUiControlError(400, "invalid_request", "Skill 文件必须是 UTF-8 文本。");
    return Object.freeze({ path: field(file, "path", 1024), content: file.content });
  });
}

async function translate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof WebUiControlError) throw error;
    if (error instanceof SkillImportError) {
      const status = ["skill_import_unavailable", "skill_import_unsupported_host", "skill_import_failed", "skill_import_cleanup_required"].includes(error.code) ? 503
        : /conflict|changed|exists|unsafe_target/u.test(error.code) ? 409 : 400;
      throw new WebUiControlError(status, error.code, error.message);
    }
    if (error instanceof TypeError) throw new WebUiControlError(400, "invalid_skill", error.message);
    if (error instanceof Error && /changed|unknown|no longer available|origin|retired/u.test(error.message)) {
      throw new WebUiControlError(409, "skill_changed", "Skill 已变化或不可用，请刷新目录后重新选择。");
    }
    throw error;
  }
}

export default {
  name: "skills-webui-control", inject: ["skills", "workspace", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, SKILLS_WEBUI_CONTROL, createSkillsWebUiControl(ctx.skills, ctx.workspace));
  },
};
