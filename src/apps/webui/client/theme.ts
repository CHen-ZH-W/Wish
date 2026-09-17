import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";

export type WishTheme = "light" | "dark";
export type WishLanguage = "zh-CN" | "en-US";
export type WishFontSize = "standard" | "large" | "extra-large";

export function textFor(language: WishLanguage, zh: string, en: string): string {
  return language === "en-US" ? en : zh;
}

interface ThemeRoot { setAttribute(name: string, value: string): void }

/** Presentation adapter only; the Host-owned Settings snapshot remains canonical. */
export function bindAppearance(model: SettingsClientModel, root: ThemeRoot = document.documentElement): () => void {
  const apply = () => {
    root.setAttribute("data-theme", selectedTheme(model));
    root.setAttribute("lang", selectedLanguage(model));
    root.setAttribute("data-font-size", selectedFontSize(model));
  };
  const remove = model.subscribe(apply);
  apply();
  return remove;
}

/** Kept for callers that used the earlier theme-only adapter. */
export const bindTheme = bindAppearance;

export function selectedTheme(model: SettingsClientModel): WishTheme {
  const value = model.getSnapshot().sections.find(section => section.namespace === "webui-appearance")?.value.theme;
  return value === "dark" ? "dark" : "light";
}

export function selectedLanguage(model: SettingsClientModel): WishLanguage {
  const value = model.getSnapshot().sections.find(section => section.namespace === "webui-appearance")?.value.language;
  return value === "en-US" ? "en-US" : "zh-CN";
}

export function selectedFontSize(model: SettingsClientModel): WishFontSize {
  const value = model.getSnapshot().sections.find(section => section.namespace === "webui-appearance")?.value["font-size"];
  return value === "large" || value === "extra-large" ? value : "standard";
}
