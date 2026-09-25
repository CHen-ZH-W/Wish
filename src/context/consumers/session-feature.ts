import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
export default { name: "context-session-feature", inject: ["application", "contextEngine", "sessions", "agents"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "context", {
    async inspect(sessionId) {
      const session = await ctx.sessions.manager.get({ sessionId });
      if (session.agentId !== ctx.agents.agentId) throw new Error("Context observation belongs to another Agent");
      const observations = ctx.contextEngine.observations.list(sessionId);
      return { key: "context", title: "Context 组装观察", titleEn: "Context assembly inspection", text: "这里是进程内有界的投影摘要：Provider、消息顺序、可用工具与预算。没有复刻请求，也不包含指令正文；unknown 表示没有可靠 Token 计数。\n\n" + (observations.length ? JSON.stringify(observations, null, 2) : "本进程尚无此会话的投影记录。"),
        textEn: "This is a bounded in-process projection summary: Provider, message order, available tools, and budget. It does not recreate a request or include instruction bodies; unknown means no reliable token count.\n\n" + (observations.length ? JSON.stringify(observations, null, 2) : "No projection record for this session in this process."), token: {}, actions: [] };
    },
    async act() { throw new Error("Context observation is read-only"); },
  }, { codeReload: true });
} };
