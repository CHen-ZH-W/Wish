export type SystemPromptAuthority = "system" | "developer";

export type SystemPromptPlacement = "stable_prefix" | "dynamic_tail";

/** One independently owned contribution to the model-visible prompt. */
export interface SystemPromptSection {
  readonly id: string;
  readonly content: string;
  readonly authority?: SystemPromptAuthority;
  readonly order?: number;
  /**
   * A section with Tool requirements is admitted only when every named Tool is
   * available in the immutable Step snapshot.
   */
  readonly requiredTools?: readonly string[];
  /** Tool-dependent sections may only use dynamic_tail. */
  readonly placement?: SystemPromptPlacement;
}

/** Validated, immutable section retained by the registry. */
export interface RegisteredSystemPromptSection {
  readonly id: string;
  readonly content: string;
  readonly authority: SystemPromptAuthority;
  readonly order: number;
  readonly requiredTools: readonly string[];
  readonly placement: SystemPromptPlacement;
}

export interface SystemPromptAssemblyInput {
  /** Final model-visible Tool names for this Step, after policy filtering. */
  readonly availableTools: readonly string[];
}

export interface SystemPromptRegistration {
  readonly section: RegisteredSystemPromptSection;
  unregister(): boolean;
}
