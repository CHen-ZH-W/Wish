import type { UiSlots } from "../../../apps/webui/client/slots.js";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { SkillFeatureEntry } from "../../presentation.js";
import type { SkillsClientModel } from "./model.js";
import { useText } from "../../../apps/webui/client/i18n.js";

export function SkillsNavigation({ model, slots }: { model: SkillsClientModel; slots: UiSlots }) {
  const t = useText();
  const state = useSnapshot(model);
  if (!state.sessionId) return <p className="session-empty muted">{t("请先在执行工作区选择或创建会话。", "Choose or create a session in the workspace first.")}</p>;
  if (!state.skills.length) return <p className="session-empty muted">{t("当前 Workspace 没有可浏览的 Skill。", "No Skills are available in this workspace.")}</p>;
  const groups = [["workspace", t("工作区", "Workspace")], ["user", t("用户", "User")]] as const;
  return <nav className="skill-navigation" aria-label={t("Skill 列表", "Skill list")}>{groups.map(([source, label]) => {
    const skills = state.skills.filter(skill => skill.source === source);
    return skills.length ? <section key={source} className="skill-navigation-group"><header><h2>{label}</h2><span>{skills.length}</span></header>
      {skills.map(skill => <SkillNavigationItem key={skill.packageId} skill={skill} selected={state.selected?.entry.packageId === skill.packageId}
        disabled={!state.available || state.pending} onSelect={() => { void model.select(skill.name); slots.openPanel("skills"); }} />)}</section> : null;
  })}</nav>;
}

function SkillNavigationItem({ skill, selected, disabled, onSelect }: { skill: SkillFeatureEntry; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const t = useText();
  return <button className={selected ? "navigation-item skill-navigation-item selected" : "navigation-item skill-navigation-item"}
    aria-current={selected ? "page" : undefined} title={skill.description} disabled={disabled} onClick={onSelect}>
    <span>{skill.name}</span><small>{skill.modelInvocable ? t("模型可读取", "Model-readable") : t("仅人工查看", "Manual review only")}</small>
  </button>;
}

export function SkillsPage({ model }: { model: SkillsClientModel }) {
  const t = useText();
  const state = useSnapshot(model);
  return <section className="settings-page skills-page"><header className="page-heading"><div><h1>Skills</h1><p>{t("浏览当前会话 Workspace 可用的操作说明；查看不会激活 Skill、授予权限或执行脚本。", "Browse instructions available in this session's workspace. Viewing a Skill does not activate it, grant permissions, or run scripts.")}</p></div></header>
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {!state.sessionId ? <p className="notice">{t("请先在执行工作区选择或创建会话。", "Choose or create a session in the workspace first.")}</p>
      : !state.skills.length ? <p className="list-empty">{t("当前 Workspace 没有可浏览的 Skill。", "No Skills are available in this workspace.")}</p>
      : state.selected ? <article className="skill-content"><header><div><h2>{state.selected.entry.name}</h2><p>{state.selected.entry.description}</p></div><span className="record-state">{state.selected.entry.modelInvocable ? t("模型可按需读取", "Model-readable on demand") : t("仅人工查看", "Manual review only")}</span></header>
        <pre className="skill-document">{state.selected.content}</pre></article>
      : <div className="skill-empty"><h2>{t("选择一个 Skill", "Choose a Skill")}</h2><p>{t("目录已显示在左侧。选择后会读取经过版本校验的完整正文。", "Choose one from the sidebar to read its version-checked instructions.")}</p></div>}
    {state.selectionChanged ? <p className="notice warning">{t("之前查看的 Skill 已变化或不可用，请从左侧重新选择。", "The Skill you viewed has changed or is unavailable. Choose it again from the sidebar.")}</p> : null}
    {state.issues.length ? <details className="skill-issues"><summary>{t("目录诊断（", "Catalog diagnostics (")}{state.issues.length}{t("）", ")")}</summary><ul>{state.issues.map(issue => <li key={`${issue.location}:${issue.message}`}><code>{issue.location}</code><span>{issue.message}</span></li>)}</ul></details> : null}
  </section>;
}
