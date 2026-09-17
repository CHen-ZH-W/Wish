import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { CredentialStatus } from "../../../credentials/types.js";
import { canonicalModelSelection } from "../../selection.js";
import { settingOptionValue, type SettingEnumOption, type SettingsView } from "../../../settings/types.js";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";

export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly provider?: string;
  readonly model?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly apiKeyEnv?: string;
}

export interface ModelsSettingsClientSnapshot {
  readonly section: SettingsView | null;
  readonly choices: readonly ModelChoice[];
  readonly selectedModel: string | null;
  readonly credentials: Readonly<Record<string, CredentialStatus>>;
  readonly writable: boolean;
  readonly online: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly status: string | null;
}

/** Models-owned browser projection. React never handles transport or secret persistence. */
export class ModelsSettingsClientModel extends SnapshotStore<ModelsSettingsClientSnapshot> {
  private readonly removers: Array<() => void> = [];
  private credentialGeneration = 0;
  private referenceSignature = "";
  private operation = false;
  private closed = false;

  constructor(
    private readonly settings: SettingsClientModel,
    private readonly connection: ClientConnection,
  ) {
    super(Object.freeze({ section: null, choices: Object.freeze([]), selectedModel: null,
      credentials: Object.freeze({}), writable: false, online: false, pending: false, error: null, status: null }));
    this.removers.push(settings.subscribe(this.sync), connection.subscribe(this.sync));
    this.sync();
  }

  selectModel = async (reference: string): Promise<void> => {
    const state = this.requireWritable();
    if (!state.choices.some(choice => choice.value === reference)) throw new Error("模型当前不可用");
    this.operation = true;
    this.publish({ ...state, selectedModel: reference, pending: true, error: null, status: "正在切换…" });
    try {
      const committed = await this.settings.save(state.section!, { ...state.section!.user, "default-model": reference });
      this.operation = false;
      if (!this.closed) this.publish({ ...this.getSnapshot(), section: committed, selectedModel: reference, pending: false, status: "已应用于新运行" });
    } catch (error) { this.fail(error); throw error; }
  };

  setContextWindow = async (reference: string, tokens: number | undefined): Promise<void> => {
    const state = this.requireWritable();
    if (!state.choices.some(choice => choice.value === reference)) throw new Error("模型当前不可用");
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 1024 || tokens > 10_000_000)) {
      throw new Error("上下文窗口必须是 1K 到 10M 之间的整数");
    }
    this.operation = true;
    const overrides = contextWindowOverrides(state.section!.value["context-window-overrides"]);
    if (tokens === undefined) delete overrides[reference];
    else overrides[reference] = tokens;
    const user = { ...state.section!.user };
    if (Object.keys(overrides).length) user["context-window-overrides"] = JSON.stringify(overrides);
    else delete user["context-window-overrides"];
    this.publish({ ...state, pending: true, error: null, status: "正在应用…" });
    try {
      const committed = await this.settings.save(state.section!, user);
      this.operation = false;
      if (!this.closed) this.publish({ ...this.getSnapshot(), section: committed, pending: false, status: "下一次请求使用新窗口" });
    } catch (error) { this.fail(error); throw error; }
  };

  setMaxOutputTokens = async (reference: string, tokens: number | undefined): Promise<void> => {
    const state = this.requireWritable();
    const choice = state.choices.find(item => item.value === reference);
    if (choice === undefined) throw new Error("模型当前不可用");
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 10_000_000 ||
      (choice.maxOutputTokens !== undefined && tokens > choice.maxOutputTokens))) {
      throw new Error("最大输出 token 数必须是正整数，且不能超过模型支持的上限");
    }
    this.operation = true;
    const overrides = tokenOverrides(state.section!.value["max-output-token-overrides"]);
    if (tokens === undefined) delete overrides[reference];
    else overrides[reference] = tokens;
    const user = { ...state.section!.user };
    if (Object.keys(overrides).length) user["max-output-token-overrides"] = JSON.stringify(overrides);
    else delete user["max-output-token-overrides"];
    this.publish({ ...state, pending: true, error: null, status: "正在应用…" });
    try {
      const committed = await this.settings.save(state.section!, user);
      this.operation = false;
      if (!this.closed) this.publish({ ...this.getSnapshot(), section: committed, pending: false, status: "下一次请求使用新上限" });
    } catch (error) { this.fail(error); throw error; }
  };

  setCredential = async (reference: string, value: string): Promise<void> => {
    const state = this.requireWritable();
    const normalized = normalizeApiKey(value);
    this.operation = true;
    this.publish({ ...state, pending: true, error: null, status: "正在安全写入…" });
    try {
      const response = await this.connection.request<{ credential: CredentialStatus }>("/api/management/credentials/set", { reference, value: normalized });
      this.operation = false;
      if (!this.closed) this.publish({ ...this.getSnapshot(), credentials: Object.freeze({ ...this.getSnapshot().credentials, [reference]: response.credential }), pending: false, status: "API 密钥已更新" });
    } catch (error) { this.fail(error); throw error; }
  };

  deleteCredential = async (reference: string): Promise<void> => {
    const state = this.requireWritable();
    this.operation = true;
    this.publish({ ...state, pending: true, error: null, status: "正在清除…" });
    try {
      const response = await this.connection.request<{ credential: CredentialStatus }>("/api/management/credentials/delete", { reference });
      this.operation = false;
      if (!this.closed) this.publish({ ...this.getSnapshot(), credentials: Object.freeze({ ...this.getSnapshot().credentials, [reference]: response.credential }), pending: false, status: "API 密钥已清除" });
    } catch (error) { this.fail(error); throw error; }
  };

  close(): void {
    this.closed = true;
    this.credentialGeneration++;
    for (const remove of this.removers.splice(0)) remove();
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const settings = this.settings.getSnapshot(), connection = this.connection.getSnapshot();
    const section = settings.sections.find(view => view.namespace === "models") ?? null;
    const choices = section === null ? Object.freeze([]) : modelChoices(section);
    const stored = section === null ? null : String(section.value["default-model"] ?? "");
    const selected = stored === null ? null : canonicalModelSelection(stored, new Set(choices.map(choice => choice.value)));
    const pending = this.operation || settings.pending;
    this.publish({ ...this.getSnapshot(), section, choices, selectedModel: pending ? this.getSnapshot().selectedModel ?? selected : selected,
      writable: settings.writable, online: connection.online, pending, error: settings.error ?? this.getSnapshot().error });
    const references = [...new Set(choices.flatMap(choice => choice.apiKeyEnv === undefined ? [] : [choice.apiKeyEnv]))].sort();
    const signature = `${connection.online}:${references.join("\n")}`;
    if (signature !== this.referenceSignature) {
      this.referenceSignature = signature;
      if (connection.online && references.length) void this.refreshCredentials(references);
    }
  };

  private async refreshCredentials(references: readonly string[]): Promise<void> {
    const generation = ++this.credentialGeneration;
    try {
      const response = await this.connection.request<{ credentials: readonly CredentialStatus[] }>("/api/management/credentials/describe", { references });
      if (this.closed || generation !== this.credentialGeneration) return;
      this.publish({ ...this.getSnapshot(), credentials: Object.freeze(Object.fromEntries(response.credentials.map(status => [status.reference, status]))) });
    } catch (error) {
      if (!this.closed && generation === this.credentialGeneration) this.fail(error);
    }
  }

  private requireWritable(): ModelsSettingsClientSnapshot {
    const state = this.getSnapshot();
    if (this.closed || state.section === null || !state.writable || !state.online || state.pending) throw new Error("模型设置当前不可写");
    return state;
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.operation = false;
    this.publish({ ...this.getSnapshot(), pending: false, status: null,
      error: error instanceof Error ? error.message : "模型设置修改失败" });
  }
}

export function modelChoices(view: SettingsView): readonly ModelChoice[] {
  const field = view.fields.find(candidate => candidate.key === "default-model");
  if (field?.type !== "enum") return Object.freeze([]);
  return Object.freeze(field.options.map(option => {
    const value = settingOptionValue(option);
    const rich = typeof option === "string" ? undefined : option as SettingEnumOption;
    const attributes = rich?.attributes;
    return Object.freeze({ value, label: rich?.label ?? value,
      ...(typeof attributes?.provider === "string" ? { provider: attributes.provider } : {}),
      ...(typeof attributes?.model === "string" ? { model: attributes.model } : {}),
      ...(typeof attributes?.contextWindowTokens === "number" ? { contextWindowTokens: attributes.contextWindowTokens } : {}),
      ...(typeof attributes?.maxOutputTokens === "number" ? { maxOutputTokens: attributes.maxOutputTokens } : {}),
      ...(typeof attributes?.defaultMaxOutputTokens === "number" ? { defaultMaxOutputTokens: attributes.defaultMaxOutputTokens } : {}),
      ...(typeof attributes?.apiKeyEnv === "string" ? { apiKeyEnv: attributes.apiKeyEnv } : {}),
    });
  }));
}

export function contextWindowOverrides(value: unknown): Record<string, number> {
  return tokenOverrides(value);
}

export function tokenOverrides(value: unknown): Record<string, number> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])));
  } catch { return {}; }
}

export function parseCapacity(input: string): number | undefined {
  const value = input.trim();
  if (!value.length) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(value);
  if (!match) return Number.NaN;
  const scale = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  const scaled = Number(match[1]) * scale, rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : Number.NaN;
}

export function formatCapacity(value: number | undefined): string {
  if (value === undefined) return "";
  if (value % 1_000_000 === 0) return `${String(value / 1_000_000)}M`;
  if (value % 1_000 === 0) return `${String(value / 1_000)}K`;
  return String(value);
}

function normalizeApiKey(input: string): string {
  const value = input.trim();
  if (!value.length || value.length > 8192 || !/^[\x21-\x7e]+$/u.test(value) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value) ||
    value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    throw new Error("请输入密钥本身，不要包含变量名、引号、空格或换行");
  }
  return value;
}
