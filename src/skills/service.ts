import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReadSkillRequest, SkillCatalog, SkillLookup, SkillResource, Skills, SkillSource, SkillPackageSnapshot } from "./types.js";
import type { SkillImportCapabilities, SkillImportRequest } from "./import-types.js";
import type { SkillSummary } from "./types.js";

export abstract class SkillsService extends Service implements Skills {
  constructor(ctx: Context) { super(ctx, "skills"); }
  abstract list(input: SkillLookup): Promise<SkillCatalog>;
  abstract read(input: ReadSkillRequest): Promise<SkillResource>;
  importCapabilities(): SkillImportCapabilities | undefined { return undefined; }
  async importPackage(_input: SkillImportRequest): Promise<SkillSummary> { throw new Error("This Skills Provider does not support package import"); }
  registerSource(_source: SkillSource): () => void { throw new Error("This Skills Provider does not support registered sources"); }
  async snapshot(input: SkillLookup): Promise<readonly SkillPackageSnapshot[]> {
    const catalog = await this.list(input);
    if (catalog.skills.length || catalog.issues.length) throw new Error("This Skills Provider cannot capture complete packages");
    return Object.freeze([]);
  }
}
declare module "@deepseek-ai/cordis" { interface Context { skills: SkillsService; } }
