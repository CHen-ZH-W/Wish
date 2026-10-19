/** Private plugin data only. Session history and control-plane records have separate owners. */
export type PluginStateValue = null | boolean | number | string | readonly PluginStateValue[] | { readonly [key: string]: PluginStateValue };

export interface PluginStateIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
  /** Loader-observed SHA-256 of the entry module; embeddings supply an immutable build digest. */
  readonly artifactDigest: string;
  readonly schemaVersion: number;
}
export interface PluginStateSnapshot {
  readonly formatVersion: 1;
  readonly key: string;
  readonly writer: PluginStateIdentity;
  readonly configurationDigest: string;
  readonly value: PluginStateValue;
  readonly previous: string | null;
  readonly digest: string;
}
export interface PluginStateDefinition {
  readonly identity: Omit<PluginStateIdentity, "artifactDigest"> & { readonly artifactDigest?: string };
  readonly readableVersions: readonly number[];
  readonly migratableVersions?: readonly number[];
  /** Reject malformed private data before exposing the successor service. */
  validate(value: PluginStateValue): void;
  snapshot(): PluginStateValue | Promise<PluginStateValue>;
  restore(snapshot: PluginStateSnapshot): void | Promise<void>;
  /** Pure data transformation. Must not perform external side effects. */
  migrate?(snapshot: PluginStateSnapshot): PluginStateValue | Promise<PluginStateValue>;
}
export interface PluginStateHandle {
  readonly key: string;
  /** Serialize state mutations; success is returned only after a durable checkpoint. */
  run<T>(action: () => T | Promise<T>): Promise<T>;
  /** Join earlier mutations, snapshot, then fsync before returning. */
  flush(): Promise<PluginStateSnapshot>;
  close(): Promise<void>;
}
export interface PluginStateIndex {
  readonly heads: Readonly<Record<string, string>>;
  readonly pending: null | {
    readonly requestId: string;
    readonly before: Readonly<Record<string, string>>;
    readonly staged: Readonly<Record<string, string>>;
  };
}
/** Provider port. Writes must be atomic and durable; the index uses explicit CAS. */
export interface PluginStatePersistence {
  readIndex(): Promise<{ readonly value: PluginStateIndex; readonly revision?: string }>;
  writeIndex(value: PluginStateIndex, revision: string | undefined): Promise<string>;
  readSnapshot(digest: string): Promise<PluginStateSnapshot>;
  writeSnapshot(snapshot: PluginStateSnapshot): Promise<void>;
  close(): Promise<void>;
}
