import { assertActiveCapabilityAuthorizationGrant } from "../../permissions/authorization.js";
import { WebAccessDeniedError, WebError, WebExecutionFailedError, WebPolicyMismatchError, WebResponseTooLargeError } from "../errors.js";
import type { RunWebSearchRequest, WebSearchPolicy, WebSearchSpec } from "../types.js";

export function assertSearchAuthority(request: RunWebSearchRequest, policy: WebSearchPolicy, issued: WeakSet<WebSearchSpec>): void {
  const { context, grant, spec } = request;
  if (!issued.has(spec)) {
    throw new WebPolicyMismatchError(
      "Web Search spec was not issued by this Provider",
    );
  }
  if (
    spec.providerId !== policy.providerId ||
    spec.policyVersion !== policy.version
  ) throw new WebPolicyMismatchError("Web Search Provider policy changed");
  if (
    context.permissions.workspace.fingerprint !== context.workspace.fingerprint ||
    context.permissions.workspace.revision !== context.workspace.revision
  ) {
    throw new WebPolicyMismatchError(
      "Permission Snapshot belongs to another Workspace Snapshot",
    );
  }
  if (!context.permissions.ceiling.allowedCapabilities.includes("web.search")) {
    throw new WebAccessDeniedError("Permission ceiling excludes web.search");
  }
  try {
    assertActiveCapabilityAuthorizationGrant(grant, {
      policyVersion: context.permissions.policyVersion,
      authorityVersion: context.permissions.authorityVersion,
    });
  } catch (cause: unknown) {
    throw new WebAccessDeniedError(errorMessage(cause), { cause });
  }
  const permitted = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "web.search" &&
    requirement.providers.includes(policy.providerId)
  );
  if (!permitted) {
    throw new WebAccessDeniedError(
      `Grant does not include web.search for ${policy.providerId}`,
    );
  }
}

export async function readSearchResponse(
  response: Response,
  maxBytes: number,
  callerSignal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new WebResponseTooLargeError(maxBytes);
  }
  if (response.body === null) {
    throw new WebExecutionFailedError("Web Search response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WebResponseTooLargeError(maxBytes);
      }
      chunks.push(item.value);
    }
  } catch (cause: unknown) {
    if (callerSignal?.aborted === true) throw abortReason(callerSignal);
    if (cause instanceof WebError) throw cause;
    throw new WebExecutionFailedError(
      `Web Search response read failed: ${errorMessage(cause)}`,
      { cause },
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new WebExecutionFailedError(
      "Web Search response is not valid UTF-8",
      { cause },
    );
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new Error("Web Search was aborted"); }
