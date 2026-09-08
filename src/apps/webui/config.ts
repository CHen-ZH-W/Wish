import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ModelEnvironment } from "../../models/types.js";
import {
  loadWishHostConfiguration,
  type LoadWishHostConfigurationInput,
  type WishHostConfiguration,
} from "../config.js";

export const DEFAULT_WISH_WEBUI_HOST = "127.0.0.1";
export const DEFAULT_WISH_WEBUI_PORT = 8790;

export interface WishWebUiConfiguration {
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string;
  readonly application: WishHostConfiguration;
}

export interface LoadWishWebUiConfigurationInput
  extends LoadWishHostConfigurationInput {
  readonly host?: string;
  readonly port?: number;
  readonly workspaceRoot?: string;
  readonly cwd?: string;
}

/** Resolve WebUI process settings while reusing the shared App configuration. */
export async function loadWishWebUiConfiguration(
  input: LoadWishWebUiConfigurationInput = {},
): Promise<WishWebUiConfiguration> {
  const {
    host: inputHost,
    port: inputPort,
    workspaceRoot: inputWorkspaceRoot,
    cwd: inputCwd,
    ...applicationInput
  } = input;
  const environment: ModelEnvironment = input.environment ?? process.env;
  const host = requireText(
    inputHost ?? environment.WISH_WEBUI_HOST ?? DEFAULT_WISH_WEBUI_HOST,
    "WebUI host",
  );
  const port = inputPort ?? parsePort(
    environment.WISH_WEBUI_PORT,
  ) ?? DEFAULT_WISH_WEBUI_PORT;
  requirePort(port);
  const workspaceRoot = await requireDirectory(
    inputWorkspaceRoot ?? environment.WISH_WEBUI_WORKSPACE_ROOT ??
      inputCwd ?? process.cwd(),
  );
  const application = await loadWishHostConfiguration({
    ...applicationInput,
    environment,
  });
  return Object.freeze({ host, port, workspaceRoot, application });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("WISH_WEBUI_PORT must be an integer from 1 to 65535");
  }
  return Number(value);
}

function requirePort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("WebUI port must be an integer from 1 to 65535");
  }
}

async function requireDirectory(path: string): Promise<string> {
  const resolved = resolve(requireText(path, "WebUI workspace root"));
  let information;
  try {
    information = await stat(resolved);
  } catch (error: unknown) {
    throw new Error(`WebUI workspace cannot be read: ${resolved}`, {
      cause: error,
    });
  }
  if (!information.isDirectory()) {
    throw new Error(`WebUI workspace is not a directory: ${resolved}`);
  }
  return realpath(resolved);
}

function requireText(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}
