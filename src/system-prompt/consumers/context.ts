import type { Context } from "@deepseek-ai/cordis";

import type { ContextInput } from "../../context/types.js";
import type { ContextItem, ContextProvider } from "../../core/context/projector.js";
import type { SystemPrompt } from "../service.js";

/** Projects only dynamic System Prompt sections into conversation Context. */
export class SystemPromptContextProvider
  implements ContextProvider<ContextInput>
{
  readonly id = "system-prompt";

  constructor(private readonly systemPrompt: SystemPrompt) {}

  provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): readonly ContextItem[] {
    signal?.throwIfAborted();
    const sections = this.systemPrompt.assemble({
      availableTools: input.request?.availableTools ?? [],
    });
    signal?.throwIfAborted();
    return Object.freeze(
      sections.filter((section) => section.placement === "dynamic_tail").map((section) =>
        Object.freeze({
          id: `system-prompt:${section.id}`,
          kind: "instruction" as const,
          placement: section.placement,
          message: Object.freeze({
            role: section.authority,
            content: section.content,
          }),
        })
      ),
    );
  }
}

export const SystemPromptContext = {
  name: "system-prompt-context",
  inject: ["systemPrompt", "contextEngine"],
  apply(ctx: Context): void {
    const provider = new SystemPromptContextProvider(ctx.systemPrompt);
    ctx.contextEngine.registerProvider(provider);
  },
};

export default SystemPromptContext;
