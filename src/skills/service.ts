import { Service, type Context } from "@deepseek-ai/cordis";
import type { ReadSkillRequest, SkillCatalog, SkillLookup, SkillResource, Skills } from "./types.js";

export abstract class SkillsService extends Service implements Skills {
  constructor(ctx: Context) { super(ctx, "skills"); }
  abstract list(input: SkillLookup): Promise<SkillCatalog>;
  abstract read(input: ReadSkillRequest): Promise<SkillResource>;
}
declare module "@deepseek-ai/cordis" { interface Context { skills: SkillsService; } }
