import type { SkillImportCapabilities } from "../import-types.js";
import type { SkillFeatureEntry } from "../presentation.js";

/** Skills-owned global library projection, independent of Session selection. */
export interface SkillsLibraryView {
  readonly schemaVersion: 1;
  readonly workspace: { readonly root: string; readonly fingerprint: string; readonly revision: string };
  readonly catalogDigest: string;
  readonly skills: readonly SkillFeatureEntry[];
  readonly issues: readonly { readonly location: string; readonly message: string }[];
  readonly import?: SkillImportCapabilities;
}

export interface SkillDocumentView {
  readonly schemaVersion: 1;
  readonly entry: SkillFeatureEntry;
  readonly content: string;
}

export interface SkillImportView {
  readonly schemaVersion: 1;
  readonly catalog: SkillsLibraryView;
  readonly imported: SkillFeatureEntry;
}
