/** Retired DeepSeek Flash names remain callable, but saved selections use the current model. */
const LEGACY_DEEPSEEK_FLASH = new Set([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
]);
const CURRENT_DEEPSEEK_FLASH = "deepseek/deepseek-flash";

export function canonicalModelSelection(reference: string, available: ReadonlySet<string>): string {
  return LEGACY_DEEPSEEK_FLASH.has(reference) && available.has(CURRENT_DEEPSEEK_FLASH)
    ? CURRENT_DEEPSEEK_FLASH
    : reference;
}
