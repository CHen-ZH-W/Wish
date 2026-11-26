/** React-free immutable snapshot source; unchanged reads keep identity. */
export class SnapshotStore<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  readonly getSnapshot = (): T => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected publish(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = Object.freeze(value);
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* One observer cannot suppress other observers. */ } }
  }
}

/** Only apply to parsed wire data, never to React components or service objects. */
export function freezeWire<T>(value: T): T {
  // Iterative traversal avoids overflowing the stack on deeply nested JSON input.
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== "object" || Object.isFrozen(next)) continue;
    Object.freeze(next); for (const child of Object.values(next)) pending.push(child);
  }
  return value;
}

/** Fold invalidations during a read into one successor; a stale read never overwrites the successor. */
export class RefreshQueue extends SnapshotStore<boolean> {
  private pending: Promise<void> | undefined;
  private version = 0;
  private closed = false;
  constructor(private readonly refresh: (current: () => boolean) => Promise<void>) { super(false); }
  request(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.version++;
    this.publish(true);
    return this.pending ??= this.run().finally(() => { this.pending = undefined; this.publish(false); });
  }
  /** Periodic checks share an in-flight read; only a real invalidation makes it stale. */
  poll(): Promise<void> { return this.pending ?? this.request(); }
  /** Observe the current read and its folded successors without invalidating a valid in-flight response. */
  whenSettled(): Promise<void> { return this.pending ?? Promise.resolve(); }
  close(): void { this.closed = true; this.version++; this.publish(false); }
  private async run(): Promise<void> {
    let version: number;
    do { version = this.version; await this.refresh(() => !this.closed && version === this.version); }
    while (!this.closed && version !== this.version);
  }
}
