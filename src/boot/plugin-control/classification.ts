import type { PluginManagementClass } from "./types.js";
import type { WishPluginManifestView } from "./manifest.js";

export type DeclaredPluginManagementClass = Exclude<PluginManagementClass, "noncompliant">;

export interface PluginManagementSubject {
  readonly id: string;
  readonly name: string;
  readonly group: boolean;
}

export interface ManagedPluginEntryDeclaration {
  readonly managementClass: "managed";
  readonly manifest?: WishPluginManifestView;
}

export interface PluginManagementDescription {
  readonly managementClass: PluginManagementClass;
  readonly manifest: WishPluginManifestView | null;
}

/**
 * Host-owned declarations. Module declarations come from the built-in Catalog;
 * entry declarations come from the managed deployment Profile. Runtime state
 * and naming conventions never promote an unknown plugin to Kernel or managed.
 */
export class PluginManagementClassifier {
  private readonly modules: ReadonlyMap<string, DeclaredPluginManagementClass>;
  private readonly entries = new Map<object, ReadonlyMap<string, ManagedPluginEntryDeclaration>>();

  constructor(modules: Readonly<Record<string, DeclaredPluginManagementClass>> = {}) {
    this.modules = new Map(Object.entries(modules));
  }

  classify(subject: PluginManagementSubject): PluginManagementClass {
    return this.describe(subject).managementClass;
  }

  describe(subject: PluginManagementSubject): PluginManagementDescription {
    if (subject.group) return Object.freeze({ managementClass: "structural", manifest: null });
    const moduleClass = this.modules.get(subject.name);
    if (moduleClass !== undefined) return Object.freeze({ managementClass: moduleClass, manifest: null });
    const declaration = this.entryDeclaration(subject.id);
    return Object.freeze({
      managementClass: declaration?.managementClass ?? "noncompliant",
      manifest: declaration?.manifest ?? null,
    });
  }

  /** Catalog authority only; Profile declarations cannot promote another module. */
  moduleClass(name: string): DeclaredPluginManagementClass | undefined {
    return this.modules.get(name);
  }

  /** Replace one Profile generation's declarations without exposing mutation to plugins. */
  replaceEntries(owner: object, declarations: ReadonlyMap<string, ManagedPluginEntryDeclaration | "managed">): void {
    this.entries.set(owner, new Map([...declarations].map(([id, declaration]) => [id,
      declaration === "managed" ? Object.freeze({ managementClass: "managed" as const }) : declaration])));
  }

  removeEntries(owner: object): void {
    this.entries.delete(owner);
  }

  private entryDeclaration(id: string): ManagedPluginEntryDeclaration | undefined {
    let result: ManagedPluginEntryDeclaration | undefined;
    for (const declarations of this.entries.values()) {
      const candidate = declarations.get(id);
      if (candidate === undefined) continue;
      result = candidate;
    }
    return result;
  }
}
