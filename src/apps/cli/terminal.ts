import { once } from "node:events";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface WishCliTerminal {
  readonly interactive: boolean;
  /** Lets readline forward terminal Ctrl+C instead of swallowing the signal. */
  setInterruptHandler?(handler: () => void): void;
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  readAll(): Promise<string>;
  writeOutput(text: string): Promise<void>;
  writeError(text: string): Promise<void>;
  close(): void;
}

export interface NodeWishCliTerminalOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly error?: Writable;
  readonly interactive?: boolean;
}

/** Node terminal adapter; prompts use stderr so one-shot stdout stays composable. */
export class NodeWishCliTerminal implements WishCliTerminal {
  readonly interactive: boolean;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly error: Writable;
  private interface: Interface | undefined;
  private closed = false;
  private closedPromise: Promise<void> | undefined;
  private interruptHandler: (() => void) | undefined;

  constructor(options: NodeWishCliTerminalOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.error = options.error ?? process.stderr;
    this.interactive = options.interactive ?? Boolean(
      (this.input as Readable & { readonly isTTY?: boolean }).isTTY,
    );
  }

  setInterruptHandler(handler: () => void): void {
    this.interruptHandler = handler;
  }

  async readLine(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.interactive || this.closed || signal?.aborted === true) {
      return undefined;
    }
    const terminal = this.ensureInterface();
    const closed = this.closedPromise ??= once(terminal, "close").then(() => {});
    try {
      return await Promise.race([
        terminal.question(prompt, signal === undefined ? {} : { signal }),
        closed.then(() => undefined),
      ]);
    } catch (error: unknown) {
      if (
        isAborted(signal) || this.closed ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async readAll(): Promise<string> {
    if (this.interface !== undefined) {
      throw new Error("Cannot read piped input after starting terminal prompts");
    }
    let text = "";
    for await (const chunk of this.input) {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    }
    return text;
  }

  writeOutput(text: string): Promise<void> {
    return write(this.output, text);
  }

  writeError(text: string): Promise<void> {
    return write(this.error, text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interface?.close();
  }

  private ensureInterface(): Interface {
    if (this.interface !== undefined) return this.interface;
    this.interface = createInterface({
      input: this.input,
      output: this.error,
      terminal: this.interactive,
    });
    this.interface.on("SIGINT", () => this.interruptHandler?.());
    return this.interface;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function write(stream: Writable, text: string): Promise<void> {
  if (text.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(text, (error: Error | null | undefined) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}
