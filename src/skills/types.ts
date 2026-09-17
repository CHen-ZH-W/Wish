/** Invocation-neutral capability. Loading a package never executes its scripts. */
export interface SkillSummary {
  /** Stable source + package location identity, distinct from content version. */
  readonly packageId: string;
  readonly name: string;
  readonly description: string;
  readonly source: "user" | "workspace";
  readonly location: string;
  readonly digest: string;
  readonly modelInvocable: boolean;
}

export interface SkillCatalog {
  readonly skills: readonly SkillSummary[];
  readonly issues: readonly { readonly location: string; readonly message: string }[];
}

export interface SkillLookup {
  /** Canonical cwd supplied by Workspace, not a model-selected directory. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ReadSkillRequest extends SkillLookup {
  readonly name: string;
  /** Pin the catalog version; re-discover instead of loading a changed package. */
  readonly expectedDigest: string;
  /** Model Consumers must pin origin as well as content. Host reads may opt in. */
  readonly expectedPackageId?: string;
  readonly path?: string;
  /** Unicode code-point offsets; omitting limit reads the complete bounded file. */
  readonly offset?: number;
  readonly limit?: number;
  /** Required for continuation pages; pins the resource independently of SKILL.md. */
  readonly expectedResourceDigest?: string;
  /** Host selects invocation kind. Models may not choose this value. */
  readonly invocation?: "host" | "model";
}

export interface SkillResource {
  readonly skill: SkillSummary;
  readonly path: string;
  readonly content: string;
  readonly digest: string;
  readonly offset: number;
  readonly totalCharacters: number;
  readonly nextOffset?: number;
  readonly complete: boolean;
}

export interface Skills {
  list(input: SkillLookup): Promise<SkillCatalog>;
  read(input: ReadSkillRequest): Promise<SkillResource>;
}
