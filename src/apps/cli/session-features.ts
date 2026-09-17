import type { SessionFeatures } from "../session-features.js";
import type { WishCliTerminal } from "./terminal.js";

/** Human controls use an explicit displayed token; they never approve the latest unseen draft. */
export async function reviewCommand(features: SessionFeatures | undefined, sessionId: string, text: string, terminal: WishCliTerminal): Promise<{ handled: boolean; message?: string }> {
  if (!/^\/review(?:\s|$)/u.test(text)) return { handled: false };
  const views = await features?.inspect(sessionId) ?? [];
  const parts = text.trim().split(/\s+/u);
  if (parts.length === 1) {
    for (const view of views) {
      await terminal.writeOutput(`\n${view.title}\n${view.text}\nToken: ${JSON.stringify(view.token)}\n`);
      if (view.actions.length) await terminal.writeError(`/review ${view.key} <${view.actions.map(action => action.name).join("|")}> ${String(view.token.reviewId ?? view.token.attemptId)} <feedback>\n`);
    }
    if (views.length === 0) await terminal.writeError("No pending session reviews.\n");
    return { handled: true };
  }
  const [, key, action, reviewId, ...feedbackParts] = parts;
  const view = views.find((item) => item.key === key);
  if (!view || !action || (view.token.reviewId ?? view.token.attemptId) !== reviewId || !view.actions.some((item) => item.name === action)) {
    throw new Error("Stale or invalid review command. Use /review to inspect the current version.");
  }
  const feedback = feedbackParts.join(" ") || undefined;
  await features!.act(sessionId, key!, action, view.token, feedback);
  if (key !== "plan") return { handled: true, message: `User resolved ${key}/${action} for ${reviewId}. Evidence: ${feedback ?? ""}. Re-read durable state before continuing.` };
  return { handled: true, message: action === "approve"
    ? `The user approved review ${reviewId}. Continue with the approved plan.`
    : action === "keep-planning" ? `Continue planning. User feedback: ${feedback}`
    : "The user cancelled review. Stay in planning mode and await further instructions." };
}
