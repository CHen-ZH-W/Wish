import { createRequire } from "node:module";

// js-yaml is also used by the configuration loader; only its data schema is allowed.
const yaml = createRequire(import.meta.url)("js-yaml") as {
  readonly JSON_SCHEMA: unknown;
  load(source: string, options: { schema: unknown }): unknown;
};

export function skillName(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError("Skill name must be 1-64 lowercase letters, digits and single hyphens");
  }
  return value;
}

export function parseSkillMarkdown(content: string, directoryName: string) {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(normalized);
  if (!match) throw new TypeError("SKILL.md requires YAML frontmatter delimited by ---");
  const value = yaml.load(match[1]!, { schema: yaml.JSON_SCHEMA });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Skill metadata");
  const metadata = value as Record<string, unknown>;
  const name = skillName(metadata.name);
  if (name !== directoryName) throw new TypeError("Skill name must match its directory name");
  if (typeof metadata.description !== "string" || !metadata.description.trim() || metadata.description.length > 1024) {
    throw new TypeError("Skill description must contain 1-1024 characters");
  }
  const disabled = metadata["disable-model-invocation"];
  if (disabled !== undefined && typeof disabled !== "boolean") throw new TypeError("disable-model-invocation must be boolean");
  if (!match[2]!.trim()) throw new TypeError("Skill body must not be empty");
  return Object.freeze({ name, description: metadata.description, modelInvocable: disabled !== true });
}
