/** Module-owned, browser-safe projection for the human Skills surface. */
export interface SkillFeatureEntry {
  readonly packageId: string;
  readonly name: string;
  readonly description: string;
  readonly source: "user" | "workspace";
  readonly digest: string;
  readonly modelInvocable: boolean;
}

export interface SkillFeatureData {
  readonly schemaVersion: 1;
  readonly workspace: { readonly fingerprint: string; readonly revision: string };
  readonly skills: readonly SkillFeatureEntry[];
  readonly issues: readonly { readonly location: string; readonly message: string }[];
  readonly selected?: { readonly entry: SkillFeatureEntry; readonly content: string };
  readonly selectionChanged: boolean;
}
