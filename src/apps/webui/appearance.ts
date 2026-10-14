import type { SettingsSection } from "../../settings/types.js";

export type WishTheme = "light" | "dark";
export type WishLanguage = "zh-CN" | "en-US";
export type WishFontSize = "standard" | "large" | "extra-large";

export interface WishWebUiAppearance {
  readonly theme: WishTheme;
  readonly language: WishLanguage;
  readonly fontSize: WishFontSize;
}

export const DEFAULT_WEBUI_APPEARANCE: WishWebUiAppearance = Object.freeze({
  theme: "light",
  language: "zh-CN",
  fontSize: "standard",
});

/** Normalize the shared Host/Browser projection without giving either side a second settings owner. */
export function wishWebUiAppearance(value?: SettingsSection): WishWebUiAppearance {
  return Object.freeze({
    theme: value?.theme === "dark" ? "dark" : "light",
    language: value?.language === "en-US" ? "en-US" : "zh-CN",
    fontSize: value?.["font-size"] === "large" || value?.["font-size"] === "extra-large"
      ? value["font-size"]
      : "standard",
  });
}
