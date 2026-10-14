import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import {
  wishWebUiAppearance,
  type WishFontSize,
  type WishLanguage,
  type WishTheme,
} from "../appearance.js";

export type { WishFontSize, WishLanguage, WishTheme } from "../appearance.js";

export function textFor(language: WishLanguage, zh: string, en: string): string {
  return language === "en-US" ? en : zh;
}

interface ThemeRoot { setAttribute(name: string, value: string): void }

/** Presentation adapter only; the Host-owned Settings snapshot remains canonical. */
export function bindAppearance(model: SettingsClientModel, root: ThemeRoot = document.documentElement): () => void {
  const apply = () => {
    const value = appearanceValue(model);
    // The Host projects the canonical initial appearance into index.html. Keep it
    // until the first Settings snapshot arrives instead of reverting to defaults.
    if (value === undefined) return;
    const appearance = wishWebUiAppearance(value);
    root.setAttribute("data-theme", appearance.theme);
    root.setAttribute("lang", appearance.language);
    root.setAttribute("data-font-size", appearance.fontSize);
  };
  const remove = model.subscribe(apply);
  apply();
  return remove;
}

/** Kept for callers that used the earlier theme-only adapter. */
export const bindTheme = bindAppearance;

export function selectedTheme(model: SettingsClientModel): WishTheme {
  return wishWebUiAppearance(appearanceValue(model)).theme;
}

export function selectedLanguage(model: SettingsClientModel): WishLanguage {
  return wishWebUiAppearance(appearanceValue(model)).language;
}

export function selectedFontSize(model: SettingsClientModel): WishFontSize {
  return wishWebUiAppearance(appearanceValue(model)).fontSize;
}

function appearanceValue(model: SettingsClientModel) {
  return model.getSnapshot().sections.find(section => section.namespace === "webui-appearance")?.value;
}
