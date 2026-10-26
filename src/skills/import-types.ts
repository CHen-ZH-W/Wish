import type { SkillLookup } from "./types.js";

export interface SkillImportFile { readonly path: string; readonly content: string }
export interface SkillImportCapabilities {
  readonly maxFileBytes: number;
  readonly maxPackageBytes: number;
  readonly maxFiles: number;
}
export interface SkillImportRequest extends SkillLookup {
  readonly files: readonly SkillImportFile[];
  readonly expectedCatalogDigest: string;
  readonly overwrite?: boolean;
}
