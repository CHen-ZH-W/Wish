import { LocalSkills, SkillsService, type Skills, type SkillResource, type SkillSummary } from "../src/skills/index.js";
import { SkillContextProvider } from "../src/skills/consumers/context.js";
import { createSkillTools } from "../src/skills/consumers/model-tools.js";
import type { Context } from "@deepseek-ai/cordis";

const skills: Skills = new LocalSkills({ userRoot: "/user/skills" });
const contextProvider = new SkillContextProvider(skills);
const tools = createSkillTools(skills);
async function load(entry: SkillSummary): Promise<SkillResource> {
  return skills.read({ cwd: "/workspace", name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId });
}
function service(ctx: Context): SkillsService { return ctx.skills; }
// @ts-expect-error Model tool input is not the Host root selection interface.
const invalid: Parameters<Skills["read"]>[0] = { cwd: "/workspace", name: "inspect" };
void [contextProvider, tools, load, service, invalid];
