import type {
  CredentialDocument,
  CredentialStatus,
  CredentialStore,
  CredentialsPort,
} from "./types.js";

const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const API_KEY = /^[\x21-\x7e]+$/u;

export class CredentialsError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CredentialsError"; }
}

/**
 * Credential authority. Launch environment is immutable and wins over the
 * managed file, matching the operator intent of `NAME=value wish-webui`.
 */
export class Credentials implements CredentialsPort {
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly store: CredentialStore,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  describe(references: readonly string[]): readonly CredentialStatus[] {
    this.requireOpen();
    if (!Array.isArray(references) || references.length > 128 || new Set(references).size !== references.length) {
      throw new CredentialsError("credentials_invalid_request");
    }
    return Object.freeze(references.map(reference => this.status(requireReference(reference))));
  }

  set(reference: string, input: string): Promise<CredentialStatus> {
    reference = requireReference(reference);
    const value = normalizeApiKey(input);
    return this.write(reference, values => ({ ...values, [reference]: value }));
  }

  delete(reference: string): Promise<CredentialStatus> {
    reference = requireReference(reference);
    return this.write(reference, values => {
      const next = { ...values };
      delete next[reference];
      return next;
    });
  }

  resolve(reference: string): string | undefined {
    this.requireOpen();
    reference = requireReference(reference);
    const inherited = this.environment[reference];
    if (typeof inherited === "string" && inherited.length > 0) return inherited;
    return this.store.read().values[reference];
  }

  subscribe(listener: () => void): () => void {
    this.requireOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.listeners.clear();
    return this.closing = this.tail.catch(() => {}).then(() => this.store.close());
  }

  private write(
    reference: string,
    mutate: (values: CredentialDocument["values"]) => Record<string, string>,
  ): Promise<CredentialStatus> {
    this.requireOpen();
    if (this.status(reference).source === "environment") {
      return Promise.reject(new CredentialsError("credentials_read_only"));
    }
    const run = this.tail.catch(() => {}).then(async () => {
      this.requireOpen();
      const document = this.store.read();
      await this.store.save(document.revision, Object.freeze(mutate(document.values)));
      this.emit();
      return this.status(reference);
    });
    this.tail = run;
    return run;
  }

  private status(reference: string): CredentialStatus {
    const inherited = this.environment[reference];
    if (typeof inherited === "string" && inherited.length > 0) {
      return Object.freeze({ reference, configured: true, source: "environment" as const, writable: false });
    }
    const stored = this.store.read().values[reference];
    return Object.freeze(typeof stored === "string" && stored.length > 0
      ? { reference, configured: true, source: "stored" as const, writable: true }
      : { reference, configured: false, source: "missing" as const, writable: true });
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* One observer cannot suppress committed state. */ }
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new CredentialsError("credentials_closed");
  }
}

export function requireReference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) {
    throw new CredentialsError("credentials_invalid_reference");
  }
  return value;
}

export function normalizeApiKey(input: unknown): string {
  if (typeof input !== "string" || input.length > 8192) {
    throw new CredentialsError("credentials_invalid_value");
  }
  const value = input.trim();
  if (!value.length || !API_KEY.test(value) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value) ||
    value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    throw new CredentialsError("credentials_invalid_value");
  }
  return value;
}
