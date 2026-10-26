import { useId, useRef, useState, type FormEvent } from "react";
import type { UiSlots } from "../../../apps/webui/client/slots.js";
import { ErrorNotice, Icon, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { MarkdownContent } from "../../../apps/webui/client/ui/markdown.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { SkillFeatureEntry } from "../../presentation.js";
import { readSkillImportFiles, type SkillImportFile, type SkillsClientModel } from "./model.js";

export function SkillsNavigation({ model, slots }: { model: SkillsClientModel; slots: UiSlots }) {
  const t = useText(), state = useSnapshot(model);
  const [filter, setFilter] = useState("");
  const groups = [["workspace", t("工作区", "Workspace")], ["user", t("用户", "User")]] as const;
  const matches = state.skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  return <div className="skill-navigation-wrap">
    {state.skills.length ? <input className="skill-search" type="search" aria-label={t("搜索 Skills", "Search Skills")} placeholder={t("搜索 Skills", "Search Skills")} value={filter} onChange={event => setFilter(event.target.value)} /> : null}
    {!state.skills.length ? <p className="session-empty muted">{state.loading ? t("正在读取 Skills…", "Loading Skills…") : !state.catalog ? t("等待 Skills 目录。", "Waiting for the Skill catalog.") : t("暂无 Skill，从本机导入即可开始。", "No Skills yet. Import one to get started.")}</p> : null}
    <nav className="skill-navigation" aria-label={t("Skill 列表", "Skill list")}>{groups.map(([source, label]) => {
      const skills = matches.filter(skill => skill.source === source);
      return skills.length ? <section key={source} className="skill-navigation-group"><header><h2>{label}</h2><span>{skills.length}</span></header>
        {skills.map(skill => <SkillNavigationItem key={skill.packageId} skill={skill} selected={state.selectedName === skill.name}
          disabled={!state.available || state.importing} onSelect={() => { void model.select(skill.name); slots.openPanel("skills"); }} />)}</section> : null;
    })}</nav>
    {state.skills.length && !matches.length ? <p className="session-empty muted">{t("没有匹配的 Skill。", "No matching Skills.")}</p> : null}
  </div>;
}

function SkillNavigationItem({ skill, selected, disabled, onSelect }: { skill: SkillFeatureEntry; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const t = useText();
  return <button className={selected ? "navigation-item skill-navigation-item selected" : "navigation-item skill-navigation-item"}
    aria-current={selected ? "page" : undefined} title={skill.description} disabled={disabled} onClick={onSelect}>
    <span>{skill.name}</span><small>{skill.modelInvocable ? t("模型可读取", "Model-readable") : t("仅人工查看", "Manual review only")}</small>
  </button>;
}

export function SkillsPage({ model }: { model: SkillsClientModel }) {
  const t = useText(), state = useSnapshot(model);
  const [importOpen, setImportOpen] = useState(false);
  const selected = state.selected;
  return <section className="settings-page skills-page"><header className="page-heading"><div><h1>Skills</h1><p>{t("浏览已有 Skills，或从本机导入新的操作说明。", "Browse your Skills or import instructions from your computer.")}</p></div>
    <div className="skill-page-actions"><button onClick={() => { void model.refresh(); }} disabled={state.loading || state.importing}>{state.loading ? t("刷新中…", "Refreshing…") : t("刷新", "Refresh")}</button>
      <button className="primary" aria-expanded={importOpen} onClick={() => setImportOpen(value => !value)}><Icon name="plus" />{t("导入 Skill", "Import Skill")}</button></div></header>
    <ErrorNotice text={state.error ? skillError(state.error, t) : null} />
    <SkillImportForm model={model} open={importOpen} onClose={() => setImportOpen(false)} />
    {!state.available && state.catalog && !state.error ? <p className="notice">{t("连接恢复后将重新核对目录，当前内容仍可查看。", "The catalog will be checked when the connection returns. Loaded content remains readable.")}</p> : null}
    {state.reading ? <p className="skill-reading" role="status">{t("正在读取 Skill…", "Loading Skill…")}</p> : null}
    {selected ? <article className="skill-content" aria-busy={state.reading}>
      <button className="skill-back" onClick={model.clearSelection}><Icon name="chevron" />{t("全部 Skills", "All Skills")}</button>
      <header><div><h2>{selected.entry.name}</h2><p>{selected.entry.description}</p></div><span className="record-state">{selected.entry.modelInvocable ? t("模型可按需读取", "Model-readable on demand") : t("仅人工查看", "Manual review only")}</span></header>
      <div className="skill-document-meta"><span>{selected.entry.source === "workspace" ? t("工作区 Skill", "Workspace Skill") : t("用户 Skill", "User Skill")}</span><span>SKILL.md</span></div>
      <div className="message-markdown skill-markdown"><MarkdownContent source={skillBody(selected.content)} /></div>
      <details className="skill-source"><summary>{t("查看 SKILL.md 原文", "View SKILL.md source")}</summary><pre className="skill-document">{selected.content}</pre></details>
    </article> : state.loading && !state.catalog ? <p className="list-empty" role="status">{t("正在读取 Skills…", "Loading Skills…")}</p>
      : !state.catalog ? <div className="skill-empty"><Icon name="book" /><h2>{t("暂时无法读取 Skills", "Skills are unavailable")}</h2><p>{t("恢复连接后刷新目录，即可查看已有 Skills。", "Restore the connection and refresh to see your Skills.")}</p></div>
      : state.skills.length ? <SkillLibraryList model={model} />
      : <div className="skill-empty"><Icon name="book" /><h2>{t("还没有 Skill", "No Skills yet")}</h2><p>{t("导入一个 SKILL.md，或包含说明和资源的 Skill 文件夹。", "Import a SKILL.md file or a Skill folder with instructions and resources.")}</p><button onClick={() => setImportOpen(true)}>{t("导入第一个 Skill", "Import your first Skill")}</button></div>}
    {state.selectionChanged ? <p className="notice warning">{t("之前查看的 Skill 已变化或不可用，请重新选择。", "The Skill you viewed has changed or is unavailable. Choose it again.")}</p> : null}
    {state.issues.length ? <details className="skill-issues"><summary>{t("目录诊断（", "Catalog diagnostics (")}{state.issues.length}{t("）", ")")}</summary><ul>{state.issues.map(issue => <li key={`${issue.location}:${issue.message}`}><code>{issue.location}</code><span>{issue.message}</span></li>)}</ul></details> : null}
    {state.catalog ? <p className="skill-workspace-source">{t("工作区来源", "Workspace source")}<code>{state.catalog.workspace.root}</code></p> : null}
  </section>;
}

function SkillLibraryList({ model }: { model: SkillsClientModel }) {
  const t = useText(), state = useSnapshot(model);
  return <div className="skill-library"><div className="skill-library-heading"><h2>{t("已有 Skills", "Your Skills")}</h2><span>{state.skills.length}</span></div>
    <div className="skill-library-list">{state.skills.map(skill => <button key={skill.packageId} className="skill-library-item" disabled={!state.available || state.importing} onClick={() => { void model.select(skill.name); }}>
      <span className="skill-library-icon"><Icon name="book" /></span><span className="skill-library-copy"><strong>{skill.name}</strong><span>{skill.description || t("暂无描述", "No description")}</span></span>
      <span className="skill-library-source">{skill.source === "workspace" ? t("工作区", "Workspace") : t("用户", "User")}</span><Icon name="chevron" /></button>)}</div>
  </div>;
}

type Draft = { readonly files: readonly SkillImportFile[]; readonly name: string; readonly bytes: number };
function SkillImportForm({ model, open, onClose }: { model: SkillsClientModel; open: boolean; onClose: () => void }) {
  const t = useText(), state = useSnapshot(model), id = useId();
  const directoryInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [draft, setDraft] = useState<Draft | null>(null), [overwrite, setOverwrite] = useState(false);
  const [reading, setReading] = useState(false), [error, setError] = useState<string | null>(null), [success, setSuccess] = useState<string | null>(null);
  const limits = state.catalog?.import;
  const busy = reading || state.importing;
  async function choose(files: FileList | null): Promise<void> {
    if (!files?.length || !limits) return;
    const selected = Array.from(files), version = ++generation.current;
    setReading(true); setError(null); setSuccess(null);
    try {
      const decoded = await readSkillImportFiles(selected, limits);
      if (version !== generation.current) return;
      const path = selected[0]!.webkitRelativePath;
      setDraft({ files: decoded, name: path ? path.split("/")[0]! : selected[0]!.name, bytes: selected.reduce((sum, file) => sum + file.size, 0) });
      setOverwrite(false);
    } catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === generation.current) setReading(false); }
  }
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!draft || busy) return;
    setError(null); setSuccess(null);
    try {
      const imported = await model.importPackage(draft.files, overwrite);
      setSuccess(t(`已导入 ${imported.name}。`, `Imported ${imported.name}.`));
      setDraft(null); setOverwrite(false);
    } catch (reason) {
      // Host errors are shown above the form; local admission errors belong to the draft.
      if (!model.getSnapshot().error) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <form className="skill-import" hidden={!open} onSubmit={event => { void submit(event); }} aria-labelledby={`${id}-title`}>
    <header><div><h2 id={`${id}-title`}>{t("从本机导入", "Import from your computer")}</h2><p>{t("保存到用户 Skills 目录，供各个会话使用。文件夹中需包含 SKILL.md。", "Save to your user Skills for use across conversations. Folders must contain SKILL.md.")}</p></div><button type="button" className="skill-import-close" aria-label={t("收起导入", "Close import")} disabled={busy} onClick={onClose}><Icon name="close" /></button></header>
    <div className="skill-import-pickers"><button type="button" disabled={busy || !limits} onClick={() => directoryInput.current?.click()}><Icon name="folder" />{t("选择文件夹", "Choose folder")}</button><button type="button" disabled={busy || !limits} onClick={() => fileInput.current?.click()}>{t("选择 SKILL.md", "Choose SKILL.md")}</button>
      <input ref={directoryInput} type="file" hidden multiple {...{ webkitdirectory: "" }} aria-label={t("选择 Skill 文件夹", "Choose a Skill folder")} onChange={event => { void choose(event.target.files); event.target.value = ""; }} />
      <input ref={fileInput} type="file" hidden accept=".md" aria-label={t("选择 SKILL.md", "Choose SKILL.md")} onChange={event => { void choose(event.target.files); event.target.value = ""; }} />
      {reading ? <span className="skill-import-hint" role="status">{t("正在检查文件…", "Checking files…")}</span> : limits ? <span className="skill-import-hint">{t(`最多 ${limits.maxFiles} 个文本文件，共 ${formatBytes(limits.maxPackageBytes)}`, `Up to ${limits.maxFiles} text files, ${formatBytes(limits.maxPackageBytes)} total`)}</span> : <span className="skill-import-hint">{t("当前目录不支持导入，请刷新后重试。", "Import is unavailable. Refresh the catalog and try again.")}</span>}
    </div>
    <ErrorNotice text={error ? skillError(error, t) : null} />
    {draft ? <div className="skill-import-draft"><div className="skill-import-draft-heading"><strong>{draft.name}</strong><span>{t(`${draft.files.length} 个文件`, `${draft.files.length} files`)} · {formatBytes(draft.bytes)}</span></div>
      <details className="skill-import-files"><summary>{t("查看待导入文件", "Review selected files")}</summary><ul>{draft.files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul></details>
      <label className="skill-import-overwrite"><input type="checkbox" checked={overwrite} disabled={busy} onChange={event => setOverwrite(event.target.checked)} /><span>{t("覆盖用户目录中的同名 Skill", "Replace a Skill with the same name in your user directory")}</span></label>
      {overwrite ? <p className="setting-warning">{t("导入后将替换这个用户 Skill 的整个文件夹。", "Importing replaces the entire folder for this user Skill.")}</p> : null}
      <div className="skill-import-submit"><button type="submit" className="primary" disabled={busy || !state.available || !limits}>{state.importing ? t("正在导入…", "Importing…") : t("开始导入", "Import Skill")}</button><button type="button" disabled={busy} onClick={() => { setDraft(null); setError(null); setOverwrite(false); }}>{t("清除选择", "Clear selection")}</button></div>
    </div> : null}
    {success ? <p className="skill-import-success" role="status">{success}</p> : null}
  </form>;
}

function skillBody(source: string): string { return source.replace(/^\uFEFF/u, "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim(); }
function formatBytes(bytes: number): string { return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${Math.ceil(bytes / 1000)} KB` : `${bytes} B`; }
function skillError(error: string, t: (zh: string, en: string) => string): string {
  const messages: Record<string, readonly [string, string]> = {
    skills_import_unavailable: ["Skills 暂不可导入，请恢复连接并刷新目录。", "Import is unavailable. Restore the connection and refresh the catalog."],
    skills_import_state_changed: ["连接已变化，请刷新目录确认导入结果。", "The connection changed. Refresh the catalog to check the import result."],
    skills_invalid_response: ["无法读取 Skills，请刷新目录后重试。", "Could not read Skills. Refresh the catalog and try again."],
    skills_import_file_count: ["选择的文件数量超出限制，请选择一个 Skill 文件夹或 SKILL.md。", "Too many files selected. Choose one Skill folder or a SKILL.md file."],
    skills_import_file_too_large: ["文件过大，请移除大文件后重新选择。", "A file is too large. Remove large files and choose the folder again."],
    skills_import_package_too_large: ["Skill 文件总大小超出限制，请精简后重新选择。", "The Skill exceeds the size limit. Remove large files and choose it again."],
    skills_import_request_too_large: ["导入内容超出传输限制，请精简文件后重试。", "The import exceeds the transfer limit. Remove some files and try again."],
    skills_import_invalid_utf8: ["包含无法读取的文本或二进制文件，请只保留 UTF-8 文本文件。", "A file is not valid UTF-8 text. Choose a folder containing only UTF-8 text files."],
    skill_import_conflict: ["用户目录已有同名 Skill。勾选覆盖后可替换。", "A user Skill with this name exists. Select replace to overwrite it."],
    skill_import_catalog_changed: ["Skills 目录已变化，请刷新后重新确认导入。", "The Skills catalog changed. Refresh it and review the import again."],
  };
  const entry = messages[error]; return entry ? t(entry[0], entry[1]) : error;
}
