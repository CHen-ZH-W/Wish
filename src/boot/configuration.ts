import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ModelEnvironment } from "../models/types.js";
import type { ConfigurationSource } from "./launch.js";

const DEFAULT_CONFIGURATION_URL = new URL("../config/cordis.yml", import.meta.url);

export interface ResolvedWishConfiguration {
  readonly url: URL;
  readonly source: ConfigurationSource;
}

/** Resolve only the profile location; Loader owns profile evaluation and reload. */
export function resolveWishConfiguration(
  input: string | URL | undefined,
  environment: ModelEnvironment,
  cwd: string,
): ResolvedWishConfiguration {
  let source: ConfigurationSource = "option";
  if (input === undefined) {
    const configured = environment.CORDIS_CONFIG;
    if (configured === undefined) {
      return Object.freeze({
        url: new URL(DEFAULT_CONFIGURATION_URL.href),
        source: "built-in",
      });
    }
    input = requireConfigurationPath(configured, "CORDIS_CONFIG");
    source = "environment";
  }

  const url = input instanceof URL
    ? new URL(input.href)
    : pathToFileURL(isAbsolute(input)
      ? requireConfigurationPath(input, "Cordis configuration")
      : resolve(cwd, requireConfigurationPath(input, "Cordis configuration")));
  if (url.protocol !== "file:") {
    throw new TypeError("Cordis configuration must be a local file");
  }
  return Object.freeze({ url, source });
}

function requireConfigurationPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed path`);
  }
  return value;
}
