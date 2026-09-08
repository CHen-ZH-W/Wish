import type { WishOutputEvent } from "../types.js";
import type { WishCliTerminal } from "./terminal.js";

export class WishCliEventRenderer {
  private outputLineOpen = false;
  private reasoningLineOpen = false;

  constructor(private readonly terminal: WishCliTerminal) {}

  async render(events: AsyncIterable<WishOutputEvent>): Promise<void> {
    for await (const event of events) {
      if (event.type === "model.stream") {
        await this.renderModelEvent(event.payload);
      } else if (event.type === "tool.lifecycle") {
        await this.renderToolEvent(event.payload);
      } else {
        await this.renderRuntimeEvent(event.payload);
      }
    }
    await this.finish();
  }

  async finish(): Promise<void> {
    await this.closeReasoningLine();
    await this.closeOutputLine();
  }

  private async renderModelEvent(
    event: Extract<WishOutputEvent, { readonly type: "model.stream" }>["payload"],
  ): Promise<void> {
    switch (event.type) {
      case "reasoning_delta":
        if (!this.reasoningLineOpen) {
          await this.terminal.writeError("[reasoning] ");
          this.reasoningLineOpen = true;
        }
        await this.terminal.writeError(event.text);
        break;
      case "text_delta":
        await this.closeReasoningLine();
        await this.terminal.writeOutput(event.text);
        this.outputLineOpen = true;
        break;
      case "retry":
        await this.closeReasoningLine();
        await this.terminal.writeError(
          `[model] retry ${event.retryCount}: ${event.error.message}\n`,
        );
        break;
      case "error":
        await this.closeReasoningLine();
        await this.terminal.writeError(`[model] ${event.error.message}\n`);
        break;
      case "done":
        await this.closeReasoningLine();
        await this.closeOutputLine();
        break;
      case "start":
      case "tool_call":
        break;
    }
  }

  private async renderToolEvent(
    event: Extract<WishOutputEvent, { readonly type: "tool.lifecycle" }>["payload"],
  ): Promise<void> {
    await this.closeReasoningLine();
    switch (event.type) {
      case "tool.dispatched":
        await this.terminal.writeError(`[tool] ${event.call.name} running\n`);
        break;
      case "tool.completed":
        await this.terminal.writeError(`[tool] ${event.call.name} completed\n`);
        break;
      case "tool.authorization_denied":
        await this.terminal.writeError(
          `[tool] ${event.call.name} denied: ${event.reason}\n`,
        );
        break;
      case "tool.failed":
        await this.terminal.writeError(
          `[tool] ${event.call.name} failed: ${event.result.error.message}\n`,
        );
        break;
      case "tool.aborted":
        await this.terminal.writeError(`[tool] ${event.call.name} aborted\n`);
        break;
      case "tool.queued":
      case "tool.prepared":
      case "tool.authorization_requested":
        break;
    }
  }

  private async renderRuntimeEvent(
    event: Extract<WishOutputEvent, { readonly type: "runtime.transition" }>["payload"],
  ): Promise<void> {
    if (event.type === "control.steering_delivered") {
      await this.closeOutputLine();
      await this.terminal.writeError(
        `[control] steering delivered to ${event.stepId}\n`,
      );
    } else if (event.type === "control.follow_up_dequeued") {
      await this.closeOutputLine();
      await this.terminal.writeError(
        `[control] follow-up ${event.controlId} started\n`,
      );
    }
  }

  private async closeOutputLine(): Promise<void> {
    if (!this.outputLineOpen) return;
    this.outputLineOpen = false;
    await this.terminal.writeOutput("\n");
  }

  private async closeReasoningLine(): Promise<void> {
    if (!this.reasoningLineOpen) return;
    this.reasoningLineOpen = false;
    await this.terminal.writeError("\n");
  }
}
