import { PluginWorkOwner } from "wish/plugins/work-owner";

export default {
  name: "example-greeting-provider",
  apply(ctx, config = {}) {
    if (typeof (config.prefix ?? "Hello") !== "string") throw new TypeError("prefix must be a string");
    const prefix = config.prefix ?? "Hello";
    const work = new PluginWorkOwner(ctx, { code: "example_greeting", codeReload: true });
    ctx.provide("exampleGreeting", Object.freeze({
      greet: text => work.run(() => `${prefix}, ${text}`),
    }));
  },
};
