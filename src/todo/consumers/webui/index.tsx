import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";
import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import type { RunClientModel } from "../../../apps/webui/client/model/run.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { TodoItem, TodoState } from "../../types.js";

function TodoConversationCard({ model, run, sessions, sessionId }: { readonly model: FeaturesClientModel; readonly run: RunClientModel; readonly sessions: SessionClientModel; readonly sessionId: string }) {
  const language = useLanguage(), t = useText(), state = useSnapshot(model), observedRun = useSnapshot(run), selected = useSnapshot(sessions);
  const view = state.sessionId === sessionId ? state.views.find(item => item.key === "todo") : undefined;
  const todo = parseTodoState(view?.data);
  if (!todo?.items.length) return null;
  // Feature reads may still contain the old list while Host cleanup drains.
  // A terminal event belongs to this exact Run, so it can hide that list now.
  if (observedRun.runId === todo.runId && observedRun.terminal) return null;
  if (observedRun.runId !== null && observedRun.runId !== todo.runId) return null;
  if (selected.selectedId === sessionId && selected.runs.some(item => item.runId === todo.runId && item.status !== "running")) return null;
  const completed = todo.items.filter(item => item.status === "completed").length;
  return <section className="conversation-card todo-card" aria-labelledby={`todo-card-title-${sessionId}`}>
    <header><h2 id={`todo-card-title-${sessionId}`}>{t("任务单", "Todo")}</h2><span aria-label={t(`已完成 ${completed} 项，共 ${todo.items.length} 项`, `${completed} of ${todo.items.length} completed`)}>{completed}<span aria-hidden="true"> / </span>{todo.items.length}</span></header>
    <ol>{todo.items.map(item => <li key={item.id} data-status={item.status}><span className="todo-status-mark" aria-hidden="true" /><span className="sr-only">{statusLabel(item, language)}</span><span className="todo-item-content">{item.content}</span></li>)}</ol>
  </section>;
}

function statusLabel(item: TodoItem, language: "zh-CN" | "en-US"): string {
  if (language === "en-US") return item.status === "completed" ? "Completed: " : item.status === "in_progress" ? "In progress: " : item.status === "failed" ? "Failed: " : item.status === "stopped" ? "Stopped: " : "Pending: ";
  return item.status === "completed" ? "已完成：" : item.status === "in_progress" ? "进行中：" : item.status === "failed" ? "失败：" : item.status === "stopped" ? "已停止：" : "待处理：";
}

function parseTodoState(value: unknown): TodoState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TodoState>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.items)) return undefined;
  if (!candidate.items.every(item => item && typeof item.id === "string" && typeof item.content === "string" && (item.status === "pending" || item.status === "in_progress" || item.status === "completed" || item.status === "failed" || item.status === "stopped"))) return undefined;
  return candidate as TodoState;
}

export const TodoClientUi = {
  name: "ui-todo",
  inject: ["wishFeatures", "wishSession", "wishUiSlots"],
  apply(ctx: Context) {
    const model = ctx.wishFeatures;
    let runId: string | null = null, sequence = 0;
    const refreshFromRun = () => {
      const run = ctx.wishSession.run.getSnapshot();
      if (run.runId !== runId) { runId = run.runId; sequence = 0; }
      const incoming = run.events.filter(event => event.sequence > sequence);
      sequence = incoming.reduce((latest, event) => Math.max(latest, event.sequence), sequence);
      if (incoming.some(event => event.type === "runtime.transition" && (
        event.payload.type === "user_turn.started" ||
        event.payload.type === "run.completed" ||
        event.payload.type === "run.failed" ||
        event.payload.type === "run.aborted"
      ) || event.type === "tool.lifecycle" && event.payload.type === "tool.completed" && ["todo_write", "spawn_agent", "stop_agent", "collect_agent"].includes(event.payload.call.name))) void model.refresh();
    };
    ctx.effect(() => { const remove = ctx.wishSession.run.subscribe(refreshFromRun); refreshFromRun(); return remove; });
    // Child/Workflow completion changes Todo outside the parent Tool event stream.
    // Read only while the selected Run owns a visible Todo; the generic feature
    // poll remains a slower fallback when the card is inactive.
    ctx.effect(() => {
      let polling = false;
      const timer = setInterval(() => {
        if (polling) return;
        const selected = ctx.wishSession.getSnapshot();
        const snapshot = model.getSnapshot();
        const todo = parseTodoState(snapshot.views.find(view => view.key === "todo")?.data);
        const run = ctx.wishSession.run.getSnapshot();
        if (selected.selectedId && selected.selectedId === snapshot.sessionId && !selected.working &&
            todo?.sessionId === selected.selectedId && todo.items.length && run.runId === todo.runId && !run.terminal) {
          polling = true;
          void model.refresh().finally(() => { polling = false; });
        }
      }, 500);
      return () => clearInterval(timer);
    });
    ctx.effect(() => ctx.wishUiSlots.conversationCard({
      id: "todo",
      order: 20,
      View: ({ sessionId }) => <TodoConversationCard model={model} run={ctx.wishSession.run} sessions={ctx.wishSession} sessionId={sessionId} />,
    }));
  },
};
