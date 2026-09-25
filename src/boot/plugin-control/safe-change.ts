export interface PluginChangeRestoration {
  /** Rebuild the last committed generation. It may be called at most once. */
  restore(): Promise<void>;
  /** Verify the rebuilt generation, not merely the absence of an exception. */
  verify(): boolean | Promise<boolean>;
}

export interface PluginChangeFailure {
  /** Failure reported when no runtime mutation was started. */
  readonly rejected: string;
  /** Failure reported after a verified restoration of the committed generation. */
  readonly rolledBack: string;
  /** Failure reported when mutation cannot be proved restored. */
  readonly recovery: string;
}

export type PluginChangeFailureOutcome =
  | { readonly phase: "rejected"; readonly code: string; readonly restored: boolean }
  | { readonly phase: "recovery-required"; readonly code: string; readonly restored: false };

/**
 * Shared failure boundary for one already-serialized plugin change.
 *
 * This class deliberately does not own business state. Callers retain the old
 * module/configuration object and supply a restoration plus an explicit health
 * check before crossing their first runtime-mutation boundary.
 */
export class SafePluginChangeTransaction {
  private state: "unchanged" | "changed" | "committed" = "unchanged";
  private restoration: PluginChangeRestoration | undefined;
  private settling = false;

  /** Must be called immediately before the first close/switch side effect. */
  changed(restoration?: PluginChangeRestoration): void {
    if (this.state !== "unchanged") throw new Error("plugin_change_transaction_already_changed");
    this.state = "changed";
    this.restoration = restoration;
  }

  /** Install recovery once cleanup has made restoration safe to attempt. */
  retain(restoration: PluginChangeRestoration): void {
    if (this.state !== "changed" || this.restoration) throw new Error("plugin_change_transaction_restore_invalid");
    this.restoration = restoration;
  }

  /** Commit only after the durable success receipt is written. */
  commit(): void {
    if (this.state === "committed" || this.settling) throw new Error("plugin_change_transaction_commit_invalid");
    this.state = "committed";
    this.restoration = undefined;
  }

  get changedRuntime(): boolean { return this.state !== "unchanged"; }

  async fail(codes: PluginChangeFailure): Promise<PluginChangeFailureOutcome> {
    if (this.settling) throw new Error("plugin_change_transaction_settled");
    this.settling = true;
    if (this.state === "unchanged") {
      return Object.freeze({ phase: "rejected", code: codes.rejected, restored: false });
    }
    if (this.state === "changed" && this.restoration) {
      try {
        await this.restoration.restore();
        if (await this.restoration.verify()) {
          return Object.freeze({ phase: "rejected", code: codes.rolledBack, restored: true });
        }
      } catch { /* A failed compensation is deliberately reduced to a stable recovery code. */ }
    }
    return Object.freeze({ phase: "recovery-required", code: codes.recovery, restored: false });
  }
}
