import type { ToolAuthorizationInput } from "../../core/tools/authorization.js";
import type {
  BasicToolContext,
  ToolApprovalPort,
  ToolApprovalResponse,
} from "../../tools/index.js";
import type { WishCliTerminal } from "./terminal.js";

const MAX_VISIBLE_INPUT_CHARS = 8_192;

export interface CliToolApprovalOptions {
  readonly terminal: WishCliTerminal;
}

/** One-shot terminal approval; it never creates a persistent allow rule. */
export class CliToolApprovalPort implements ToolApprovalPort<BasicToolContext> {
  constructor(private readonly options: CliToolApprovalOptions) {}

  async requestApproval(
    input: ToolAuthorizationInput<BasicToolContext>,
    signal?: AbortSignal,
  ): Promise<ToolApprovalResponse> {
    if (!this.options.terminal.interactive) {
      await this.options.terminal.writeError(
        `[tool] denied ${input.call.name}: approval requires an interactive terminal\n`,
      );
      return Object.freeze({
        status: "denied" as const,
        reason: "Tool approval requires an interactive terminal",
      });
    }

    await this.options.terminal.writeError(formatApproval(input));
    const answer = await this.options.terminal.readLine(
      "Allow this call once? [y/N] ",
      signal,
    );
    if (signal?.aborted === true) {
      return Object.freeze({
        status: "denied" as const,
        reason: "Tool approval was cancelled because the Run was aborted",
      });
    }
    const normalized = answer?.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") {
      return Object.freeze({
        status: "approved" as const,
        metadata: Object.freeze({ source: "wish-cli", persistence: "once" }),
      });
    }
    return Object.freeze({
      status: "denied" as const,
      reason: answer === undefined
        ? "Tool approval was not answered"
        : "Tool approval was denied by the user",
    });
  }
}

function formatApproval(input: ToolAuthorizationInput<BasicToolContext>): string {
  const callInput = input.call.status === "ready"
    ? visibleJson(input.call.input)
    : "<invalid input>";
  const requirements = input.capabilities.requirements.length === 0
    ? "  - none\n"
    : input.capabilities.requirements.map((requirement) => {
        switch (requirement.capability) {
          case "filesystem.read":
          case "filesystem.write":
            return `  - ${requirement.capability}: ${requirement.paths.join(", ")}`;
          case "process.exec":
            return `  - process.exec: ${requirement.commands?.join(", ") ?? "unspecified"}`;
          case "network.connect":
            return `  - network.connect: ${requirement.hosts.join(", ")}`;
          case "external.side_effect":
          case "runtime.read":
          case "runtime.control":
            return `  - ${requirement.capability}: ${requirement.resources.join(", ")}`;
        }
      }).join("\n") + "\n";
  const effects = input.capabilities.effects;
  const effectText = effects === undefined
    ? ""
    : `Effects: destructive=${String(effects.destructive ?? false)}, openWorld=${String(effects.openWorld ?? false)}\n`;
  return `\nTool approval requested\nTool: ${input.call.name}\nWorkspace: ${input.context.cwd}\nInput: ${callInput}\nCapabilities:\n${requirements}${effectText}`;
}

function visibleJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = "<unserializable input>";
  }
  if (text === undefined) text = "undefined";
  if (text.length <= MAX_VISIBLE_INPUT_CHARS) return text;
  return `${text.slice(0, MAX_VISIBLE_INPUT_CHARS)}… <truncated>`;
}
