import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../../tools/managed.js";

import { createSubagentTools } from "./tools.js";
import { SubagentResultRelay } from "../../adapters/runtime-results.js";
import { SubagentToolDispatchService } from "./dispatch.js";
import { TodoSubagentProgress } from "../../../todo/subagent-progress.js";
import type {} from "../../../todo/service.js";
import type {} from "../../../workflow/service.js";

export const SubagentTools = {
  name: "subagent-tools",
  inject: ["tools", "subagents"],
  apply(ctx: Context): void {
    const dispatch = new SubagentToolDispatchService(ctx, ctx.subagents, ctx.tools,
      () => ctx.get("subagentLauncher")?.runtimeFeatures ?? [],
      role => ctx.get("agents")?.presetForRole(role));
    const resultRelay = new SubagentResultRelay({ subagents: ctx.subagents });
    let todoProgress: TodoSubagentProgress | undefined;
    const progress = () => {
      const todo = ctx.get("todo");
      if (!todo) throw new Error("Todo progress service is unavailable");
      return todoProgress ??= new TodoSubagentProgress(todo, ctx.subagents, () => ctx.get("workflow")?.state);
    };
    ctx.effect(() => () => todoProgress?.close());
    const owner = new ManagedToolOwner(ctx, { code: "subagent_tools", codeReload: true,
      blocked: () => resultRelay.pendingResults ? "subagent_results_pending" : undefined,
      close: () => resultRelay.close() });
    for (const definition of createSubagentTools({
      subagents: ctx.subagents,
      dispatch: (request, context, grant) => dispatch.dispatch(request, context, grant),
      completionObserver: resultRelay,
      todoProgress: {
        validate: link => progress().validate(link),
        beginDispatch: (link, dispatchId) => progress().beginDispatch(link, dispatchId),
        finishDispatch: (link, dispatchId, status) => progress().finishDispatch(link, dispatchId, status),
        bind: (link, record) => progress().bind(link, record),
        bindWorkflow: (link, workflowRunId) => progress().bindWorkflow(link, workflowRunId),
      },
    })) {
      owner.register(definition, undefined, { requires: ["subagents.service"] });
    }
  },
};

export default SubagentTools;
