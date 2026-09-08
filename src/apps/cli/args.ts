import type { ModelRef } from "../../core/model/model.js";
import { parseModelReference } from "../../models/config.js";

export type WishCliCommand = "interactive" | "run" | "help" | "version";

export interface WishCliArguments {
  readonly command: WishCliCommand;
  readonly modelsConfigurationPath?: string;
  readonly dataDirectory?: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly model?: ModelRef;
  readonly prompt?: string;
}

export class WishCliUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WishCliUsageError";
  }
}

export const WISH_CLI_HELP = `Usage:
  wish [options]
  wish run [options] [prompt...]

Commands:
  run                     Run one prompt and exit; reads stdin when omitted

Options:
  --session <id>          Continue an existing Session
  --cwd <path>, -C <path> Workspace for a new Session
  --title <text>          Title for a new Session
  --model <provider/name> Select the model for each new Run
  --models-config <path>  Models configuration JSON
  --data-dir <path>       Session and Tool Result data root
  --help, -h              Show this help
  --version, -v           Show the version

Interactive commands:
  /help                   Show interactive help
  /exit, /quit            Exit while no Run is active

While a Run is active:
  <text>                  Steer the next Step
  /steer <text>           Explicitly steer the next Step
  /follow-up <text>       Queue a new UserTurn in the same Run
  /abort                  Cancel the active Run
`;

/** Parse only CLI-owned syntax; Models configuration retains its own parser. */
export function parseWishCliArguments(
  argv: readonly string[],
): WishCliArguments {
  let command: Exclude<WishCliCommand, "help" | "version"> | undefined;
  let modelsConfigurationPath: string | undefined;
  let dataDirectory: string | undefined;
  let workspaceRoot: string | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;
  let model: ModelRef | undefined;
  const promptParts: string[] = [];
  let positionalsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!positionalsOnly && argument === "--") {
      positionalsOnly = true;
      continue;
    }
    if (!positionalsOnly && (argument === "--help" || argument === "-h")) {
      return Object.freeze({ command: "help" as const });
    }
    if (!positionalsOnly && (argument === "--version" || argument === "-v")) {
      return Object.freeze({ command: "version" as const });
    }
    if (!positionalsOnly && argument === "run" && command === undefined) {
      command = "run";
      continue;
    }
    if (!positionalsOnly && argument.startsWith("-")) {
      const option = splitOption(argument);
      switch (option.name) {
        case "--models-config":
          modelsConfigurationPath = assignOnce(
            modelsConfigurationPath,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--data-dir":
          dataDirectory = assignOnce(
            dataDirectory,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--cwd":
        case "-C":
          workspaceRoot = assignOnce(
            workspaceRoot,
            readOptionValue(argv, index, option),
            "--cwd",
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--session":
          sessionId = assignOnce(
            sessionId,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--title":
          title = assignOnce(
            title,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--model": {
          const text = readOptionValue(argv, index, option);
          if (model !== undefined) duplicateOption(option.name);
          model = parseModelReference(text, "CLI model");
          index += option.consumedNext ? 1 : 0;
          break;
        }
        default:
          throw new WishCliUsageError(`Unknown option: ${option.name}`);
      }
      continue;
    }
    if (command !== "run") {
      throw new WishCliUsageError(
        `Unexpected argument: ${argument}; use \"wish run ...\" for one-shot input`,
      );
    }
    promptParts.push(argument);
  }

  const resolvedCommand = command ?? "interactive";
  if (sessionId !== undefined) {
    requireTrimmed(sessionId, "--session");
    if (workspaceRoot !== undefined) {
      throw new WishCliUsageError(
        "--cwd cannot be combined with --session; Session.scope owns the workspace",
      );
    }
    if (title !== undefined) {
      throw new WishCliUsageError(
        "--title cannot be combined with --session; update Session metadata separately",
      );
    }
  }

  return Object.freeze({
    command: resolvedCommand,
    ...(modelsConfigurationPath === undefined
      ? {}
      : { modelsConfigurationPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(promptParts.length === 0
      ? {}
      : { prompt: promptParts.join(" ") }),
  });
}

interface SplitOption {
  readonly name: string;
  readonly inlineValue?: string;
  readonly consumedNext: boolean;
}

function splitOption(argument: string): SplitOption {
  const separator = argument.indexOf("=");
  if (separator < 0) {
    return { name: argument, consumedNext: true };
  }
  return {
    name: argument.slice(0, separator),
    inlineValue: argument.slice(separator + 1),
    consumedNext: false,
  };
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: SplitOption,
): string {
  const value = option.inlineValue ?? argv[index + 1];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new WishCliUsageError(`${option.name} requires a non-empty value`);
  }
  return value;
}

function assignOnce(
  current: string | undefined,
  value: string,
  option: string,
): string {
  if (current !== undefined) duplicateOption(option);
  return value;
}

function duplicateOption(option: string): never {
  throw new WishCliUsageError(`${option} may be specified only once`);
}

function requireTrimmed(value: string, option: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new WishCliUsageError(`${option} requires a non-empty trimmed value`);
  }
}
