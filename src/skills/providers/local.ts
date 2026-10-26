import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalSkills, type LocalSkillsOptions } from "../local.js";
import { SkillsService } from "../service.js";
import type { ReadSkillRequest, SkillLookup, SkillSource } from "../types.js";
import { SkillOwnerLifecycle } from "../lifecycle.js";
import { LocalSkillImporter, SkillImportError } from "../import.js";
import type { SkillImportRequest } from "../import-types.js";

export const Config: s<LocalSkillsOptions> = s.object({ userRoot: s.string(), maxSkills: s.number().step(1).min(1).max(1000), maxFileBytes: s.number().step(1).min(1).max(1_000_000) });
export default class LocalSkillsService extends SkillsService {
  static readonly inject = ["launch"];
  static readonly Config = Config;
  private readonly source: LocalSkills;
  private readonly lifecycle: SkillOwnerLifecycle;
  private readonly importer: LocalSkillImporter | undefined;
  constructor(ctx: Context, config: LocalSkillsOptions = {}) {
    super(ctx);
    const userRoot = config.userRoot ?? join(ctx.launch.homeDirectory ?? homedir(), ".wish", "skills");
    this.source = new LocalSkills({ ...config, userRoot });
    this.lifecycle = new SkillOwnerLifecycle(ctx);
    this.importer = config.frozenPackages === undefined ? new LocalSkillImporter(this.source, { userRoot, ...(config.maxFileBytes === undefined ? {} : { maxFileBytes: config.maxFileBytes }), ...(config.maxSkills === undefined ? {} : { maxSkills: config.maxSkills }) }) : undefined;
  }
  list(input: SkillLookup) { return this.lifecycle.run(() => this.source.list(input)); }
  read(input: ReadSkillRequest) { return this.lifecycle.run(() => this.source.read(input)); }
  override importCapabilities() { this.lifecycle.assertAttached(); return this.importer?.capabilities; }
  override importPackage(input: SkillImportRequest) {
    return this.lifecycle.run(() => {
      if (!this.importer) throw new SkillImportError("skill_import_unavailable", "当前隔离 Skills Provider 不支持导入。");
      return this.importer.importPackage(input);
    });
  }
  override snapshot(input: SkillLookup) { return this.lifecycle.run(() => this.source.snapshot(input)); }
  override registerSource(source: SkillSource): () => void {
    this.lifecycle.assertAttached();
    const release = this.source.registerSource(source);
    try { this.ctx.effect(() => release, `skills.source(${source.id})`); }
    catch (error) { release(); throw error; }
    this.lifecycle.own(release);
    return release;
  }
}
