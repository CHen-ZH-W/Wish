import { ToolExecutionError } from "../../../core/tools/executor.js";
import type { ToolAuthorizationGrant } from
  "../../../core/tools/authorization.js";
import { FilesystemError } from "../../index.js";
import type { Filesystem } from "../../index.js";
import type { WishToolExecutionContext } from "../../../composition/tool-context.js";

export async function readAuthorizedFile(
  filesystem: Filesystem,
  context: WishToolExecutionContext,
  grant: ToolAuthorizationGrant,
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const value = await filesystem.readFile({
    path,
    context,
    grant,
    ...(signal === undefined ? {} : { signal }),
  });
  return Buffer.from(value);
}

export async function writeAuthorizedFile(
  filesystem: Filesystem,
  context: WishToolExecutionContext,
  grant: ToolAuthorizationGrant,
  path: string,
  content: string,
  options: {
    readonly createParents?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  await filesystem.writeFile({
    path,
    context,
    grant,
    data: Buffer.from(content, "utf8"),
    ...(options.createParents === undefined
      ? {}
      : { createParents: options.createParents }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function filesystemToolError(
  operation: string,
  path: string,
  error: unknown,
): ToolExecutionError {
  if (!(error instanceof FilesystemError)) {
    return new ToolExecutionError(
      "execution_failed",
      `Could not ${operation} ${path}: ${errorMessage(error)}`,
    );
  }
  if (error.code === "filesystem_not_found") {
    return new ToolExecutionError(
      "not_found",
      `Could not ${operation} ${path}: file not found`,
    );
  }
  if (
    error.code === "filesystem_outside_workspace" ||
    error.code === "filesystem_protected_path" ||
    error.code === "filesystem_symbolic_link" ||
    error.code === "filesystem_authority_mismatch"
  ) {
    return new ToolExecutionError("permission_denied", error.message);
  }
  if (
    error.code === "filesystem_invalid_path" ||
    error.code === "filesystem_not_file" ||
    error.code === "filesystem_too_large"
  ) {
    return new ToolExecutionError("invalid_input", error.message);
  }
  return new ToolExecutionError("execution_failed", error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
