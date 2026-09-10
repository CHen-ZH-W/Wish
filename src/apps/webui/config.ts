import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_WISH_WEBUI_HOST = "127.0.0.1";
export const DEFAULT_WISH_WEBUI_PORT = 8790;

export interface WishWebUiConfiguration {
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string;
}

export interface LoadWishWebUiConfigurationInput {
  readonly host?: string;
  readonly port?: number;
  readonly workspaceRoot?: string;
  readonly cwd?: string;
}

/** Resolve only the WebUI listener and workspace settings. */
export async function loadWishWebUiConfiguration(
  input: LoadWishWebUiConfigurationInput = {},
): Promise<WishWebUiConfiguration> {
  const host = requireText(
    input.host ?? DEFAULT_WISH_WEBUI_HOST,
    "WebUI host",
  );
  const port = input.port ?? DEFAULT_WISH_WEBUI_PORT;
  requirePort(port);
  const workspaceRoot = await requireDirectory(
    input.workspaceRoot ?? input.cwd ?? process.cwd(),
  );
  return Object.freeze({ host, port, workspaceRoot });
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
