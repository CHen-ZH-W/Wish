import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalSkills, createSkillPackageSnapshot, type LocalSkillsOptions } from "../local.js";
import { SkillsService } from "../service.js";
import type { ReadSkillRequest, SkillLookup, SkillSource, SkillSummary, SkillActivationRequest } from "../types.js";
import { SkillOwnerLifecycle } from "../lifecycle.js";
import { LocalSkillImporter, SkillImportError, skillCatalogDigest } from "../import.js";
import { SkillActivationStore } from "../activation.js";
import type {} from "../../storage/binding.js";
import { StorageConflictError } from "../../storage/errors.js";
import type { SkillImportRequest } from "../import-types.js";

export const Config: s<LocalSkillsOptions> = s.object({ userRoot: s.string(), maxSkills: s.number().step(1).min(1).max(1000), maxFileBytes: s.number().step(1).min(1).max(1_000_000) });
export default class LocalSkillsService extends SkillsService {
  static readonly inject = ["launch", "storageBackend"];
  static readonly Config = Config;
  private readonly source: LocalSkills;
  private readonly lifecycle: SkillOwnerLifecycle;
  private readonly importer: LocalSkillImporter | undefined;
  private readonly activation: SkillActivationStore | undefined;
  constructor(ctx: Context, config: LocalSkillsOptions = {}) {
    super(ctx);
    const userRoot = config.userRoot ?? join(ctx.launch.homeDirectory ?? homedir(), ".wish", "skills");
    this.source = new LocalSkills({ ...config, userRoot });
    this.lifecycle = new SkillOwnerLifecycle(ctx);
    if (ctx.storageBackend && config.frozenPackages === undefined) {
      const lease = ctx.storageBackend.acquire(ctx.storageBackend.id, { kv: { list: false } });
      this.activation = new SkillActivationStore(lease, lease.id);
      this.lifecycle.own(() => lease.release());
    }
    this.importer = config.frozenPackages === undefined ? new LocalSkillImporter(this, { userRoot, ...(config.maxFileBytes === undefined ? {} : { maxFileBytes: config.maxFileBytes }), ...(config.maxSkills === undefined ? {} : { maxSkills: config.maxSkills }) }) : undefined;
  }
  list(input: SkillLookup) { return this.lifecycle.run(async () => {
    const [catalog, state] = await Promise.all([this.source.list(input), this.activation?.read(input.signal)]);
    if (!state) return catalog;
    const disabled = new Set(state.value.disabled);
    return Object.freeze({ ...catalog, skills: Object.freeze(catalog.skills.map(skill => Object.freeze({ ...skill, enabled: !disabled.has(skill.packageId) }))) });
  }); }
  read(input: ReadSkillRequest) { return this.lifecycle.run(async () => {
    const assertEnabled = async () => {
      const skill = (await this.list(input)).skills.find(item => item.name === input.name && (!input.expectedPackageId || item.packageId === input.expectedPackageId));
      if (!skill || (input.invocation === "model" && skill.enabled === false)) throw new Error("Skill is disabled or unavailable");
      return skill;
    };
    await assertEnabled();
    const resource = await this.source.read(input), skill = await assertEnabled();
    if (skill.digest !== resource.skill.digest || skill.modelInvocable !== resource.skill.modelInvocable) throw new Error("Skill changed during loading");
    return Object.freeze({ ...resource, skill });
  }); }
  override setEnabled(input: SkillActivationRequest): Promise<SkillSummary> { return this.lifecycle.run(async () => {
    if (!this.activation) throw new SkillImportError("skill_activation_unavailable", "当前 Skills Provider 不支持启停。");
    if (typeof input.enabled !== "boolean") throw new SkillImportError("skill_activation_invalid", "Skill 启停请求无效。");
    const before = await this.activation.read(input.signal), catalog = await this.list(input);
    const skill = catalog.skills.find(item => item.name === input.name && item.packageId === input.expectedPackageId && item.digest === input.expectedDigest);
    if (!skill || skillCatalogDigest(catalog) !== input.expectedCatalogDigest) throw new SkillImportError("skill_import_catalog_changed", "Skills 已变化，请刷新后重试。");
    try { await this.activation.set(skill.packageId, input.enabled, before, input.signal); }
    catch (error) {
      if (error instanceof StorageConflictError) throw new SkillImportError("skill_import_catalog_changed", "Skills 已变化，请刷新后重试。");
      throw error;
    }
    return Object.freeze({ ...skill, enabled: input.enabled });
  }); }
  override importCapabilities() { this.lifecycle.assertAttached(); return this.importer?.capabilities; }
  override importPackage(input: SkillImportRequest) {
    return this.lifecycle.run(async () => {
      if (!this.importer) throw new SkillImportError("skill_import_unavailable", "当前隔离 Skills Provider 不支持导入。");
      const imported = await this.importer.importPackage(input);
      return (await this.list(input)).skills.find(skill => skill.packageId === imported.packageId)!;
    });
  }
  override snapshot(input: SkillLookup) { return this.lifecycle.run(async () => {
    const before = await this.list(input), packages = await this.source.snapshot(input);
    if (skillCatalogDigest(before) !== skillCatalogDigest(await this.list(input))) throw new Error("Skill activation changed during capture");
    return Object.freeze(packages.map(pkg => createSkillPackageSnapshot(before.skills.find(skill => skill.packageId === pkg.skill.packageId)!,
      Object.fromEntries(pkg.resources.map(resource => [resource.path, resource.content])))));
  }); }
  override registerSource(source: SkillSource): () => void {
    this.lifecycle.assertAttached();
    const release = this.source.registerSource(source);
    try { this.ctx.effect(() => release, `skills.source(${source.id})`); }
    catch (error) { release(); throw error; }
    this.lifecycle.own(release);
    return release;
  }
}
