import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { useText } from "../../../apps/webui/client/i18n.js";
import { ErrorNotice, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { ConversationInteraction, InteractionAnswer } from "../../types.js";
import type { InteractionClientModel } from "./model.js";

/** Questions stay at their source turn; answers replace controls without moving the record. */
export function InteractionView({ request, model }: { readonly request: ConversationInteraction; readonly model: InteractionClientModel }) {
  const t = useText(), id = useId();
  useSnapshot(model.features); useSnapshot(model.sessions);
  const drafts = useSyncExternalStore(model.subscribeDrafts, () => model.draft(request.id), () => model.draft(request.id));
  const [error, setError] = useState<string | null>(null), [sending, setSending] = useState(false);
  const writable = model.canRespond(request) && !sending;
  const complete = request.questions.every(q => (drafts[q.id]?.optionIds.length ?? 0) > 0 || !!drafts[q.id]?.text.trim());
  async function respond(event?: FormEvent, dismiss = false) {
    event?.preventDefault(); if (!writable || !dismiss && !complete) return;
    setError(null); setSending(true);
    const answers: InteractionAnswer[] = request.questions.map(q => ({ questionId: q.id, optionIds: drafts[q.id]?.optionIds ?? [], text: drafts[q.id]?.text ?? "" }));
    try { await model.respond(request, dismiss ? { dismiss: true } : { answers }); }
    catch { setError(t("回答未能提交，已保留你的选择和文字。请稍后重试，或直接在下方消息中回复。", "Your answer could not be submitted. Your choices and text are kept. Retry or reply in the message box.")); }
    finally { setSending(false); }
  }
  const status = request.status === "pending" ? t("等你回答", "Your input") : request.status === "answered" ? t("已记录你的回答", "Answer recorded") : request.status === "dismissed" ? t("已跳过", "Skipped") : request.reason === "continued-in-conversation" ? t("已转回对话", "Continued in chat") : t("此问题已结束", "Question closed");
  return <section className="conversation-interaction" data-interaction-id={request.id} data-status={request.status} aria-labelledby={`${id}-title`} aria-busy={sending}>
    <header><h3 id={`${id}-title`}>{request.title}</h3><span role="status">{sending ? t("正在提交…", "Submitting…") : status}</span></header>
    {request.description ? <p className="interaction-description">{request.description}</p> : null}
    {request.status === "pending" ? <form onSubmit={event => { void respond(event); }}>
      {request.questions.map(q => {
        const draft = drafts[q.id] ?? { optionIds: [], text: "" };
        const update = (value: { optionIds?: readonly string[]; text?: string }) => model.updateDraft(request.id, q.id, { ...draft, ...value });
        return <fieldset key={q.id} disabled={!writable} className="interaction-question">
          <legend>{q.question}</legend>
          {q.why ? <p className="interaction-why">{q.why}</p> : null}
          {q.options?.length ? <div className={`interaction-options${q.multiple ? " multiple" : ""}`}>{q.options.map(option => {
            const checked = draft.optionIds.includes(option.id);
            return <label key={option.id} className="interaction-option" data-selected={checked || undefined}>
              <input type={q.multiple ? "checkbox" : "radio"} name={`${id}-${q.id}`} value={option.id} checked={checked} onChange={() => update({ optionIds: q.multiple ? checked ? draft.optionIds.filter(value => value !== option.id) : [...draft.optionIds, option.id] : [option.id] })} />
              <span><span className="interaction-option-title">{option.label}{option.recommended ? <small>{t("建议", "Suggested")}</small> : null}</span>{option.description ? <span className="interaction-option-description">{option.description}</span> : null}</span>
            </label>;
          })}</div> : null}
          {!q.multiple && draft.optionIds.length ? <button type="button" onClick={() => update({ optionIds: [] })}>{t("清除选择", "Clear choice")}</button> : null}
          <label className="interaction-free-answer"><span>{q.options?.length ? t("也可以补充或写下自己的想法", "Add context or write your own answer") : t("你的回答", "Your answer")}</span>
            <textarea rows={2} value={draft.text} onChange={event => update({ text: event.target.value })} placeholder={q.options?.length ? t("直接填写自己的方案，或补充选择的原因…", "Your own approach, or context for your choice…") : t("在这里回复…", "Write your answer…")} />
          </label>
        </fieldset>;
      })}
      <ErrorNotice text={error} />
      {!writable && !sending ? <p className="interaction-hint" role="status">{t("正在核对会话状态，恢复后即可提交。你的选择和文字已保留。", "Checking conversation state. Your choices and text are kept; submit when the connection is ready.")}</p> : null}
      <footer><button className="primary" type="submit" disabled={!writable || !complete}>{t("提交回答并继续", "Submit and continue")}</button><button type="button" disabled={!writable} onClick={() => { void respond(undefined, true); }}>{t("跳过，让 Wish 继续", "Skip and continue")}</button></footer>
      <p className="interaction-hint">{t("也可以继续在下方消息中交流。", "You can also continue in the message box below.")}</p>
    </form> : request.status === "answered" ? <dl className="interaction-receipt">{request.questions.map(q => {
      const answer = request.answers?.find(a => a.questionId === q.id);
      return <div key={q.id}><dt>{q.question}</dt><dd>{answer?.optionIds.map(optionId => <span key={optionId}>{q.options?.find(o => o.id === optionId)?.label ?? optionId}</span>)}{answer?.text ? <p>{answer.text}</p> : null}</dd></div>;
    })}</dl> : <p className="interaction-hint">{request.reason === "continued-in-conversation" ? t("继续按对话中的新消息处理，未替你选择任何方案。", "Continue with the new conversation input. No option was selected for you.") : t("记录仍保留在这里。你可以在对话中继续补充想法。", "This record stays here. Continue sharing your thoughts in the conversation.")}</p>}
  </section>;
}
