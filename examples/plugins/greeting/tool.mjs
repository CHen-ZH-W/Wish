import { ManagedToolOwner } from "wish/tools/managed";

export default {
  name: "example-greeting-tool",
  inject: ["tools", "exampleGreeting"],
  apply(ctx) {
    const owner = new ManagedToolOwner(ctx, { code: "example_greeting_tool", codeReload: true });
    owner.register({
      name: "example_greet",
      description: "Return a greeting using the configured greeting provider.",
      inputSchemaJson: JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }),
      executionMode: "parallel",
      parse: input => input && typeof input.text === "string" && Object.keys(input).length === 1
        ? { ok: true, input } : { ok: false, message: "Expected a text string" },
      resolveCapabilities: () => ({ requirements: [] }),
      execute: (input, _context, _grant, signal) => {
        signal?.throwIfAborted();
        return ctx.exampleGreeting.greet(input.text);
      },
    });
  },
};
