import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { LocalSkills } from "../skills/local.js";
import { SkillsService } from "../skills/service.js";
import { SkillOwnerLifecycle } from "../skills/lifecycle.js";
import type { ReadSkillRequest, SkillLookup, SkillSource } from "../skills/types.js";
import { validateProfileResources } from "./resources.js";

interface Config { readonly resourcesJson: string; readonly mode?: "sealed" | "overlay" }
/** Internal Worker Provider; no filesystem discovery, including after a Tool writes .agents. */
export default class ProfileSkills extends SkillsService {
  static readonly Config: s<Config> = s.object({ resourcesJson: s.string().required(), mode: s.union(["sealed", "overlay"]) });
  private readonly source: LocalSkills;
  private readonly owner: SkillOwnerLifecycle;
  readonly resourceMode: "sealed" | "overlay";
  constructor(ctx: Context, config: Config) {
    super(ctx);
    const resources = validateProfileResources(JSON.parse(config.resourcesJson));
    this.resourceMode = config.mode ?? "sealed";
    this.source = new LocalSkills({ frozenPackages: resources.skills.packages, frozenMode: config.mode ?? "sealed", maxSkills: 1000, maxFileBytes: 1_000_000 });
    this.owner = new SkillOwnerLifecycle(ctx);
  }
  list(input: SkillLookup) { return this.owner.run(() => this.source.list(input)); }
  read(input: ReadSkillRequest) { return this.owner.run(() => this.source.read(input)); }
  override snapshot(input: SkillLookup) { return this.owner.run(() => this.source.snapshot(input)); }
  override registerSource(source: SkillSource): () => void {
    this.owner.assertAttached(); const remove = this.source.registerSource(source);
    try { this.ctx.effect(() => remove, `profile.skills.source(${source.id})`); }
    catch (error) { remove(); throw error; }
    this.owner.own(remove); return remove;
  }
}
