import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalSkills, type LocalSkillsOptions } from "../local.js";
import { SkillsService } from "../service.js";
import type { ReadSkillRequest, SkillLookup } from "../types.js";
import { SkillOwnerLifecycle } from "../lifecycle.js";

export const Config: s<LocalSkillsOptions> = s.object({ userRoot: s.string(), maxSkills: s.number().step(1).min(1).max(1000), maxFileBytes: s.number().step(1).min(1).max(1_000_000) });
export default class LocalSkillsService extends SkillsService {
  static readonly inject = ["launch"];
  static readonly Config = Config;
  private readonly source: LocalSkills;
  private readonly lifecycle: SkillOwnerLifecycle;
  constructor(ctx: Context, config: LocalSkillsOptions = {}) { super(ctx); this.source = new LocalSkills({ ...config, userRoot: config.userRoot ?? join(ctx.launch.homeDirectory ?? homedir(), ".wish", "skills") }); this.lifecycle = new SkillOwnerLifecycle(ctx); }
  list(input: SkillLookup) { return this.lifecycle.run(() => this.source.list(input)); }
  read(input: ReadSkillRequest) { return this.lifecycle.run(() => this.source.read(input)); }
}
