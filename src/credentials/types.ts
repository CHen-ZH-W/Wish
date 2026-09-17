/** A credential reference is an environment-shaped public identifier, never a value. */
export type CredentialSource = "environment" | "stored" | "missing";

export interface CredentialStatus {
  readonly reference: string;
  readonly configured: boolean;
  readonly source: CredentialSource;
  /** Environment-owned values are intentionally visible as read-only. */
  readonly writable: boolean;
}

export interface CredentialDocument {
  readonly version: 1;
  readonly revision: string;
  readonly values: Readonly<Record<string, string>>;
}

/** Persistence is intentionally secret-bearing and must never cross the browser boundary. */
export interface CredentialStore {
  read(): CredentialDocument;
  save(expectedRevision: string, values: CredentialDocument["values"]): Promise<CredentialDocument>;
  close(): Promise<void>;
}

/** Browser-safe control plane plus the Host-only resolution operation. */
export interface CredentialsPort {
  describe(references: readonly string[]): readonly CredentialStatus[];
  set(reference: string, value: string): Promise<CredentialStatus>;
  delete(reference: string): Promise<CredentialStatus>;
  resolve(reference: string): string | undefined;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
