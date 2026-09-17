import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import { selectedLanguage, type WishLanguage } from "./theme.js";

const LanguageContext = createContext<WishLanguage>("zh-CN");
const chinese = (zh: string, _en: string) => zh;
const english = (_zh: string, en: string) => en;

/** UI copy follows Settings without owning another preference or changing Host data. */
export function LanguageProvider({ model, children }: { model: SettingsClientModel; children: ReactNode }) {
  const language = useSyncExternalStore<WishLanguage>(model.subscribe, () => selectedLanguage(model), () => "zh-CN");
  useEffect(() => { document.title = language === "en-US" ? "Wish · Workspace" : "Wish · 执行工作区"; }, [language]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): WishLanguage { return useContext(LanguageContext); }

/** Keep each UI owner's wording beside its view; dynamic/user content is never translated. */
export function useText(): (zh: string, en: string) => string {
  return useLanguage() === "en-US" ? english : chinese;
}
