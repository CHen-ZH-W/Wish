/** Shared, browser-safe search service metadata. Plugin identity stays independent of the service. */
export type SearchProviderId = "deepseek";
export interface SearchProviderDefinition {
  readonly id: SearchProviderId;
  readonly label: string;
  readonly credentialReference: string;
  readonly maxResults: number;
}

export const SEARCH_PROVIDERS: readonly SearchProviderDefinition[] = Object.freeze([
  Object.freeze({ id: "deepseek", label: "DeepSeek Search API", credentialReference: "WISH_DEEPSEEK_SEARCH_API_KEY", maxResults: 50 }),
]);

export function searchProvider(value: unknown): SearchProviderDefinition | undefined {
  return SEARCH_PROVIDERS.find(provider => provider.id === value);
}
