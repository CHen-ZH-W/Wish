import { settingOptionValue, type SettingEnumOption, type SettingField, type SettingsDefinition, type SettingsDocument, type SettingsSection } from "./types.js";

export class SettingsError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SettingsError"; }
}
export function settingsKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(value) && !["constructor", "prototype"].includes(value);
}
export function settingsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function settingsSection(value: unknown): SettingsSection {
  if (!settingsObject(value) || Object.keys(value).length > 64) throw new SettingsError("settings_invalid_section");
  const section: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!settingsKey(key) || !(typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) ||
      typeof item === "string" && item.length <= 4096)) throw new SettingsError("settings_invalid_value");
    section[key] = item;
  }
  return Object.freeze(section);
}
export function settingsDocument(value: unknown): SettingsDocument {
  if (!settingsObject(value) || value.version !== 1 || typeof value.revision !== "string" || !value.revision.length || value.revision.length > 100 ||
    !settingsObject(value.sections) || Object.keys(value.sections).length > 128 ||
    Object.keys(value).some(key => !["version", "revision", "sections"].includes(key))) throw new SettingsError("settings_store_corrupt");
  const sections: Record<string, SettingsSection> = {};
  for (const [key, section] of Object.entries(value.sections)) {
    if (!settingsKey(key)) throw new SettingsError("settings_store_corrupt");
    sections[key] = settingsSection(section);
  }
  const result = Object.freeze({ version: 1 as const, revision: value.revision, sections: Object.freeze(sections) });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 262144) throw new SettingsError("settings_store_too_large");
  return result;
}
export function resolveSettings(
  definition: SettingsDefinition,
  user: SettingsSection,
  options: { readonly allowStaleEnums?: boolean } = {},
): SettingsSection {
  const fields = new Map(definition.fields.map(field => [field.key, field]));
  const merged = { ...Object.fromEntries(definition.fields.map(field => [field.key, field.default])), ...definition.base, ...user };
  for (const [key, value] of Object.entries(merged)) {
    const field = fields.get(key);
    if (!field || !validFieldValue(field, value, options.allowStaleEnums === true)) throw new SettingsError("settings_validation_failed");
  }
  const result = settingsSection(merged);
  try { definition.validate?.(result); } catch { throw new SettingsError("settings_validation_failed"); }
  return result;
}
export function validateDefinition(input: SettingsDefinition): SettingsDefinition {
  if (!settingsKey(input.namespace) || !input.title || input.title.length > 160 || !Array.isArray(input.fields) ||
    !input.fields.length || input.fields.length > 64 || !["live", "next-request", "restart"].includes(input.applies)) throw new SettingsError("settings_invalid_definition");
  const keys = new Set<string>();
  const fields = input.fields.map((field: SettingField) => {
    if (!settingsKey(field.key) || keys.has(field.key) || !field.label || field.label.length > 160 ||
      (field.description?.length ?? 0) > 1024 || field.hidden !== undefined && typeof field.hidden !== "boolean") throw new SettingsError("settings_invalid_definition");
    keys.add(field.key);
    if (field.type === "number" && (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min > field.max) ||
      field.type === "string" && (!Number.isSafeInteger(field.maxLength) || field.maxLength < 0 || field.maxLength > 4096) ||
      field.type === "enum" && (!field.options.length || field.options.length > 2048 || field.options.some(value => !validOption(value)) ||
        new Set(field.options.map(settingOptionValue)).size !== field.options.length || field.allowStale !== undefined && typeof field.allowStale !== "boolean")) {
      throw new SettingsError("settings_invalid_definition");
    }
    if (!validFieldValue(field, field.default)) throw new SettingsError("settings_invalid_definition");
    return Object.freeze(field.type === "enum" ? { ...field, options: Object.freeze(field.options.map(freezeOption)) } : { ...field });
  });
  const definition = Object.freeze({ ...input, fields: Object.freeze(fields), ...(input.base === undefined ? {} : { base: settingsSection(input.base) }) });
  resolveSettings(definition, {});
  return definition;
}
function validFieldValue(field: SettingField, value: unknown, allowStaleEnums = false): boolean {
  switch (field.type) {
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string" && value.length <= field.maxLength;
    case "enum": return typeof value === "string" && (field.options.some(option => settingOptionValue(option) === value) || allowStaleEnums && field.allowStale === true && value.length <= 160);
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= field.min && value <= field.max && (!field.integer || Number.isSafeInteger(value));
    default: return false;
  }
}

function validOption(option: string | SettingEnumOption): boolean {
  if (typeof option === "string") return option.length > 0 && option.length <= 160;
  if (!settingsObject(option) || typeof option.value !== "string" || !option.value.length || option.value.length > 160 ||
    option.label !== undefined && (typeof option.label !== "string" || !option.label.length || option.label.length > 240)) return false;
  if (option.attributes === undefined) return true;
  if (!settingsObject(option.attributes) || Object.keys(option.attributes).length > 16) return false;
  return Object.entries(option.attributes).every(([key, value]) => /^[a-z][a-zA-Z0-9-]{0,63}$/u.test(key) &&
    (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 240));
}

function freezeOption(option: string | SettingEnumOption): string | SettingEnumOption {
  if (typeof option === "string") return option;
  return Object.freeze({ value: option.value, ...(option.label === undefined ? {} : { label: option.label }),
    ...(option.attributes === undefined ? {} : { attributes: Object.freeze({ ...option.attributes }) }) });
}
