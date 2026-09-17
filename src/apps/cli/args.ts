import type { ModelRef } from "../../core/model/model.js";
import type {
  ResolveRuntimeReconciliationRequest,
  RuntimeReconciliationOutcome,
} from "../../core/runtime/durability/types.js";
import { parseModelReference } from "../../models/config.js";

export type WishCliCommand =
  | "interactive"
  | "run"
  | "child"
  | "recovery-list"
  | "recovery-resolve"
  | "help"
  | "version";

export type WishCliReconciliationArguments = Omit<
  ResolveRuntimeReconciliationRequest,
  "signal"
>;

export interface WishCliArguments {
  readonly command: WishCliCommand;
  readonly modelsConfigurationPath?: string;
  readonly dataDirectory?: string;
  readonly exchangeDataDirectory?: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly model?: ModelRef;
  readonly prompt?: string;
  readonly childId?: string;
  readonly childSessionId?: string;
  readonly childRunId?: string;
  readonly promptFile?: string;
  readonly reconciliation?: WishCliReconciliationArguments;
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
  wish child [options]
  wish recovery list [options]
  wish recovery resolve [options]

Commands:
  run                     Run one prompt and exit; reads stdin when omitted
  child                   Internal tmux Subagent worker
  recovery list           List pending and resolved Tool reconciliations
  recovery resolve        Persist one operator reconciliation decision

Options:
  --session <id>          Continue an existing Session
  --cwd <path>, -C <path> Workspace for a new Session
  --title <text>          Title for a new Session
  --model <provider/name> Select the model for each new Run
  --models-config <path>  Models configuration JSON
  --data-dir <path>       Session and Tool Result data root
  --help, -h              Show this help
  --version, -v           Show the version

Recovery resolve options:
  --resolution-id <id>    Caller-owned idempotency key
  --run-id <id>           Interrupted Run
  --user-turn-id <id>     Interrupted UserTurn
  --step-id <id>          Interrupted Step
  --call-id <id>          Interrupted Tool call
  --outcome <value>       confirmed-completed, confirmed-not-completed,
                          or accepted-unknown
  --reason <text>         Operator's reconciliation reason
  --actor <text>          Operator identity (default: wish-cli-operator)
  --evidence <text>       Optional evidence; only its SHA-256 is persisted

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
  if (argv[0] === "recovery") {
    return parseRecoveryArguments(argv.slice(1));
  }
  let command: Exclude<WishCliCommand, "help" | "version"> | undefined;
  let modelsConfigurationPath: string | undefined;
  let dataDirectory: string | undefined;
  let exchangeDataDirectory: string | undefined;
  let workspaceRoot: string | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;
  let model: ModelRef | undefined;
  let childId: string | undefined;
  let childSessionId: string | undefined;
  let childRunId: string | undefined;
  let promptFile: string | undefined;
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
    if (
      !positionalsOnly && (argument === "run" || argument === "child") &&
      command === undefined
    ) {
      command = argument;
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
        case "--exchange-data-dir":
          exchangeDataDirectory = assignOnce(
            exchangeDataDirectory,
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
        case "--child-id":
          childId = assignOnce(
            childId,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--child-session":
          childSessionId = assignOnce(
            childSessionId,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--child-run":
          childRunId = assignOnce(
            childRunId,
            readOptionValue(argv, index, option),
            option.name,
          );
          index += option.consumedNext ? 1 : 0;
          break;
        case "--prompt-file":
          promptFile = assignOnce(
            promptFile,
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
  if (resolvedCommand === "child") {
    if (sessionId !== undefined || promptParts.length > 0) {
      throw new WishCliUsageError("wish child does not accept --session or positional input");
    }
    if (workspaceRoot === undefined) {
      throw new WishCliUsageError("--cwd is required for wish child");
    }
    if (dataDirectory === undefined) {
      throw new WishCliUsageError("--data-dir is required for wish child");
    }
    if (exchangeDataDirectory === undefined) {
      throw new WishCliUsageError("--exchange-data-dir is required for wish child");
    }
    childId = requiredChildOption(childId, "--child-id");
    childSessionId = requiredChildOption(childSessionId, "--child-session");
    childRunId = requiredChildOption(childRunId, "--child-run");
    promptFile = requiredChildOption(promptFile, "--prompt-file");
  } else if (
    childId !== undefined || childSessionId !== undefined ||
    childRunId !== undefined || promptFile !== undefined ||
    exchangeDataDirectory !== undefined
  ) {
    throw new WishCliUsageError("Subagent worker options require wish child");
  }
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
    ...(exchangeDataDirectory === undefined ? {} : { exchangeDataDirectory }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined ? {} : { model }),
    ...(promptParts.length === 0
      ? {}
      : { prompt: promptParts.join(" ") }),
    ...(childId === undefined ? {} : { childId }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(childRunId === undefined ? {} : { childRunId }),
    ...(promptFile === undefined ? {} : { promptFile }),
  });
}

function requiredChildOption(value: string | undefined, option: string): string {
  if (value === undefined) throw new WishCliUsageError(`${option} is required for wish child`);
  requireTrimmed(value, option);
  return value;
}

function parseRecoveryArguments(argv: readonly string[]): WishCliArguments {
  const subcommand = argv[0];
  if (subcommand !== "list" && subcommand !== "resolve") {
    throw new WishCliUsageError(
      'Recovery requires an explicit "list" or "resolve" subcommand',
    );
  }
  let modelsConfigurationPath: string | undefined;
  let dataDirectory: string | undefined;
  let resolutionId: string | undefined;
  let runId: string | undefined;
  let userTurnId: string | undefined;
  let stepId: string | undefined;
  let callId: string | undefined;
  let outcome: RuntimeReconciliationOutcome | undefined;
  let actor: string | undefined;
  let reason: string | undefined;
  let evidence: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") {
      return Object.freeze({ command: "help" as const });
    }
    if (!argument.startsWith("-")) {
      throw new WishCliUsageError(`Unexpected recovery argument: ${argument}`);
    }
    const option = splitOption(argument);
    const value = readOptionValue(argv, index, option);
    index += option.consumedNext ? 1 : 0;
    switch (option.name) {
      case "--models-config":
        modelsConfigurationPath = assignOnce(
          modelsConfigurationPath,
          value,
          option.name,
        );
        break;
      case "--data-dir":
        dataDirectory = assignOnce(dataDirectory, value, option.name);
        break;
      case "--resolution-id":
        resolutionId = assignOnce(resolutionId, value, option.name);
        break;
      case "--run-id":
        runId = assignOnce(runId, value, option.name);
        break;
      case "--user-turn-id":
        userTurnId = assignOnce(userTurnId, value, option.name);
        break;
      case "--step-id":
        stepId = assignOnce(stepId, value, option.name);
        break;
      case "--call-id":
        callId = assignOnce(callId, value, option.name);
        break;
      case "--outcome":
        if (outcome !== undefined) duplicateOption(option.name);
        outcome = reconciliationOutcome(value);
        break;
      case "--actor":
        actor = assignOnce(actor, value, option.name);
        break;
      case "--reason":
        reason = assignOnce(reason, value, option.name);
        break;
      case "--evidence":
        evidence = assignOnce(evidence, value, option.name);
        break;
      default:
        throw new WishCliUsageError(`Unknown recovery option: ${option.name}`);
    }
  }

  const common = {
    ...(modelsConfigurationPath === undefined
      ? {}
      : { modelsConfigurationPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  };
  if (subcommand === "list") {
    if (
      resolutionId !== undefined || runId !== undefined ||
      userTurnId !== undefined || stepId !== undefined || callId !== undefined ||
      outcome !== undefined || actor !== undefined || reason !== undefined ||
      evidence !== undefined
    ) {
      throw new WishCliUsageError(
        "Recovery resolution options cannot be used with recovery list",
      );
    }
    return Object.freeze({ command: "recovery-list" as const, ...common });
  }

  return Object.freeze({
    command: "recovery-resolve" as const,
    ...common,
    reconciliation: Object.freeze({
      resolutionId: requiredRecoveryOption(resolutionId, "--resolution-id"),
      runId: requiredRecoveryOption(runId, "--run-id"),
      userTurnId: requiredRecoveryOption(userTurnId, "--user-turn-id"),
      stepId: requiredRecoveryOption(stepId, "--step-id"),
      callId: requiredRecoveryOption(callId, "--call-id"),
      outcome: requiredRecoveryOption(outcome, "--outcome"),
      actor: actor ?? "wish-cli-operator",
      reason: requiredRecoveryOption(reason, "--reason"),
      ...(evidence === undefined ? {} : { evidence }),
    }),
  });
}

function reconciliationOutcome(value: string): RuntimeReconciliationOutcome {
  if (
    value !== "confirmed-completed" &&
    value !== "confirmed-not-completed" &&
    value !== "accepted-unknown"
  ) {
    throw new WishCliUsageError(`Invalid reconciliation outcome: ${value}`);
  }
  return value;
}

function requiredRecoveryOption<T>(
  value: T | undefined,
  option: string,
): T {
  if (value === undefined) {
    throw new WishCliUsageError(`${option} is required for recovery resolve`);
  }
  return value;
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
