/** Package-relative reference syntax shared by Providers and Consumers. */
export function resourcePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || value.includes("\\") || value.includes("\0")) throw new TypeError("Invalid Skill resource path");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new TypeError("Skill resource path must remain inside its package");
  if (value !== "SKILL.md" && (parts.length < 2 || !["assets", "references", "scripts"].includes(parts[0]!))) throw new TypeError("Unsupported Skill resource root");
  return value;
}
