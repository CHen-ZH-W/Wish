import { GENERATED_MODELS } from "./models.generated.js";
import { BUILT_IN_PROVIDER_DEFINITIONS } from "./provider-definitions.js";
import type { ModelSpec } from "./types.js";

/** Build a fresh JSON-shaped source so public validation owns the final snapshot. */
export function createDefaultModelsConfigurationSource(): unknown {
  const generated = GENERATED_MODELS as Readonly<
    Record<string, readonly ModelSpec[]>
  >;
  return {
    schemaVersion: 1,
    defaultModel: "deepseek/deepseek-flash",
    fallbackModels: [],
    maxRetries: 2,
    providers: BUILT_IN_PROVIDER_DEFINITIONS.map((definition) => {
      const models = generated[definition.id];
      if (models === undefined || models.length === 0) {
        throw new Error(
          `Generated Models are missing Provider "${definition.id}"`,
        );
      }
      return {
        ...definition,
        models,
      };
    }),
  };
}
