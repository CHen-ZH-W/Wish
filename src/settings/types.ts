/** Browser-safe settings contract. Never carries plugin configuration or credentials. */
export type SettingValue = string | number | boolean;
export type SettingsSection = Readonly<Record<string, SettingValue>>;
export interface SettingEnumOption {
  readonly value: string;
  readonly label?: string;
  /** Browser-safe owner facts used by an optional specialized presentation. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}
export type SettingField = {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Keep an owner-managed transport field out of the generic editor. */
  readonly hidden?: boolean;
} & (
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "string"; readonly default: string; readonly maxLength: number }
  | { readonly type: "number"; readonly default: number; readonly min: number; readonly max: number; readonly integer?: boolean }
  | {
      readonly type: "enum";
      readonly default: string;
      readonly options: readonly (string | SettingEnumOption)[];
      /** Preserve a removed stored choice long enough for the user to repair it. */
      readonly allowStale?: boolean;
    }
);

export function settingOptionValue(option: string | SettingEnumOption): string {
  return typeof option === "string" ? option : option.value;
}

export function settingOptionLabel(option: string | SettingEnumOption): string {
  return typeof option === "string" ? option : option.label ?? option.value;
}

export interface SettingsDefinition {
  readonly namespace: string;
  readonly title: string;
  readonly fields: readonly SettingField[];
  readonly base?: SettingsSection;
  readonly applies: "live" | "next-request" | "restart";
  /** Owner-only cross-field validation, never serialized. Must be pure. */
  readonly validate?: (value: SettingsSection) => void;
}

export interface SettingsView {
  readonly namespace: string;
  readonly title: string;
  readonly fields: readonly SettingField[];
  readonly applies: SettingsDefinition["applies"];
  /** Changes after a commit or owner replacement; stale editors must re-read. */
  readonly revision: string;
  readonly value: SettingsSection;
  readonly base: SettingsSection;
  readonly user: SettingsSection;
}

export interface SettingsDocument {
  readonly version: 1;
  readonly revision: string;
  readonly sections: Readonly<Record<string, SettingsSection>>;
}

/** Persistence knows raw sections, not schemas, UI or runtime lifecycle. */
export interface SettingsStore {
  readonly writable: boolean;
  read(): SettingsDocument;
  save(expectedRevision: string, sections: SettingsDocument["sections"]): Promise<SettingsDocument>;
  close(): Promise<void>;
}

export interface SettingsChange { readonly namespace: string; readonly kind: "registered" | "removed" | "committed" }
export interface SettingsReadPort {
  describe(): { readonly writable: boolean; readonly sections: readonly SettingsView[] };
  subscribe(listener: (change: SettingsChange) => void): () => void;
}
export interface SettingsWriteRequest {
  readonly namespace: string;
  readonly revision: string;
  /** Whole user layer. Missing fields re-inherit base/default values. */
  readonly user: SettingsSection;
}
export interface SettingsPort extends SettingsReadPort {
  replace(request: SettingsWriteRequest): Promise<SettingsView>;
}

export interface SettingsScope {
  get(): SettingsSection;
  view(): SettingsView;
  dispose(): void;
}
