import type { RuntimeControlReceipt } from "../../core/runtime/runtime.js";
import type { WishRunControl } from "../types.js";

export type WishCliActiveInput =
  | { readonly type: "empty" }
  | { readonly type: "help" }
  | { readonly type: "invalid"; readonly message: string }
  | { readonly type: "control"; readonly control: WishRunControl };

/** Map active-Run input by an explicit UI rule, never by semantic guessing. */
export function parseWishCliActiveInput(input: string): WishCliActiveInput {
  const text = input.trim();
  if (text.length === 0) return Object.freeze({ type: "empty" as const });
  if (text === "/help") return Object.freeze({ type: "help" as const });
  if (text === "/abort") {
    return Object.freeze({
      type: "control" as const,
      control: Object.freeze({
        type: "abort" as const,
        source: "wish-cli",
        reason: "User requested /abort",
      }),
    });
  }
  if (text.startsWith("/abort ")) {
    return invalid("/abort does not accept text");
  }
  if (text === "/steer") return invalid("Usage: /steer <message>");
  if (text.startsWith("/steer ")) {
    return steer(text.slice("/steer ".length));
  }
  if (text === "/follow-up") {
    return invalid("Usage: /follow-up <message>");
  }
  if (text.startsWith("/follow-up ")) {
    const message = text.slice("/follow-up ".length).trim();
    if (message.length === 0) return invalid("Usage: /follow-up <message>");
    return Object.freeze({
      type: "control" as const,
      control: Object.freeze({
        type: "follow_up" as const,
        source: "wish-cli",
        text: message,
        payload: Object.freeze({ text: message }),
      }),
    });
  }
  if (text === "/exit" || text === "/quit") {
    return invalid("A Run is active; use /abort before exiting");
  }
  if (text.startsWith("/")) {
    return invalid(`Unknown active-Run command: ${text.split(/\s/u, 1)[0]}`);
  }
  return steer(text);
}

export function formatWishCliControlReceipt(
  receipt: RuntimeControlReceipt,
): string {
  if (!receipt.accepted) {
    return `[control] ${displayKind(receipt.kind)} rejected: ${receipt.reason ?? "unknown reason"}\n`;
  }
  const position = receipt.position === undefined
    ? ""
    : ` at position ${receipt.position}`;
  return `[control] ${displayKind(receipt.kind)} accepted${position}\n`;
}

function steer(text: string): WishCliActiveInput {
  const message = text.trim();
  if (message.length === 0) return invalid("Usage: /steer <message>");
  return Object.freeze({
    type: "control" as const,
    control: Object.freeze({
      type: "steer" as const,
      source: "wish-cli",
      text: message,
    }),
  });
}

function invalid(message: string): WishCliActiveInput {
  return Object.freeze({ type: "invalid" as const, message });
}

function displayKind(kind: RuntimeControlReceipt["kind"]): string {
  return kind === "follow_up" ? "follow-up" : kind;
}
