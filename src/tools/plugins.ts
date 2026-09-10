import type { Context } from "@deepseek-ai/cordis";

import { createBashTool } from "./basic/bash.js";
import { createEditTool } from "./basic/edit.js";
import { createGrepTool } from "./basic/grep.js";
import { createReadTool } from "./basic/read.js";
import { createWriteTool } from "./basic/write.js";

const inject = ["tools"];

/** Independent Loader plugins; Tools.register owns cleanup on each caller fiber. */
export const Read = {
  name: "read-tool",
  inject,
  apply(ctx: Context): void {
    ctx.tools.register(createReadTool());
  },
};

export const Write = {
  name: "write-tool",
  inject,
  apply(ctx: Context): void {
    ctx.tools.register(createWriteTool());
  },
};

export const Edit = {
  name: "edit-tool",
  inject,
  apply(ctx: Context): void {
    ctx.tools.register(createEditTool());
  },
};

export const Grep = {
  name: "grep-tool",
  inject,
  apply(ctx: Context): void {
    ctx.tools.register(createGrepTool());
  },
};

export const Bash = {
  name: "bash-tool",
  inject,
  apply(ctx: Context): void {
    ctx.tools.register(createBashTool());
  },
};
