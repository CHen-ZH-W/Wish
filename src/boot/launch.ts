import type { ModelEnvironment } from "../models/types.js";

export type Surface = "cli" | "webui";
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
export type ConfigurationSource = "option" | "environment" | "built-in";

/** Launch-scoped facts and completion control exposed to Loader-managed surfaces. */
export interface Launch {
  readonly surface: Surface;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly environment: ModelEnvironment;
  readonly configurationFile: string;
  readonly configurationSource: ConfigurationSource;
  readonly completion: Promise<number>;
  readonly settled: boolean;

  complete(exitCode: number): void;
  fail(error: unknown): void;
  dispatchSignal(signal: ProcessSignal): void;
  onSignal(listener: (signal: ProcessSignal) => void): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    launch: Launch;
  }
}

export interface CreateLaunchInput {
  readonly surface: Surface;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly environment: ModelEnvironment;
  readonly configurationFile: string;
  readonly configurationSource: ConfigurationSource;
}

/** Create the single completion channel shared by bootstrap and one selected surface. */
export function createLaunch(input: CreateLaunchInput): Launch {
  let accept!: (exitCode: number) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const signalListeners = new Set<(signal: ProcessSignal) => void>();
  const pendingSignals: ProcessSignal[] = [];
  const completion = new Promise<number>((resolve, rejectPromise) => {
    accept = resolve;
    reject = rejectPromise;
  });
  // A surface can fail during the final bootstrap microtask, before the bin
  // receives this promise. Mark it handled without changing what awaiters see.
  void completion.catch(() => {});

  return Object.freeze({
    surface: input.surface,
    argv: Object.freeze([...input.argv]),
    cwd: input.cwd,
    homeDirectory: input.homeDirectory,
    environment: input.environment,
    configurationFile: input.configurationFile,
    configurationSource: input.configurationSource,
    completion,
    get settled() {
      return settled;
    },
    complete(exitCode: number) {
      if (settled) return;
      if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new TypeError("Process exit code must be an integer from 0 to 255");
      }
      settled = true;
      accept(exitCode);
    },
    fail(error: unknown) {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    },
    dispatchSignal(signal: ProcessSignal) {
      if (signalListeners.size === 0) {
        pendingSignals.push(signal);
        return;
      }
      for (const listener of [...signalListeners]) listener(signal);
    },
    onSignal(listener: (signal: ProcessSignal) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("Process signal listener must be a function");
      }
      signalListeners.add(listener);
      for (const signal of pendingSignals.splice(0)) listener(signal);
      return () => {
        signalListeners.delete(listener);
      };
    },
  });
}
