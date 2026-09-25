import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../../../boot/plugin-control/work-owner.js";

import type { ToolResultArtifact } from "../../../../core/tools/tool.js";
import type { BlobReference, BlobStorageBackend } from "../../../../storage/blob.js";
import type { StorageBackendLease } from "../../../../storage/backend.js";
import { StorageClosedError } from "../../../../storage/errors.js";
import { ToolOutputArtifactsService } from "../service.js";
import type {
  GetToolOutputArtifactRequest,
  PutToolOutputArtifactRequest,
} from "../types.js";

const BLOB_NAMESPACE = "tool-results/output-artifacts";
const LOCATOR_PREFIX = "wish-tool-output:v1:";

export interface Config {
  readonly backendId?: string;
}

export const Config: s<Config> = s.object({
  backendId: s.string(),
});

/** Content-addressed Tool output artifacts over the selected Blob Backend. */
export class BlobToolOutputArtifacts extends ToolOutputArtifactsService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;

  private readonly lease: StorageBackendLease;
  private readonly blob: BlobStorageBackend;
  private released = false;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const backendId = requireIdentifier(config.backendId ?? "file", "backendId");
    this.lease = ctx.storageBackend.acquire(backendId, {
      blob: { contentAddressed: true },
    });
    this.blob = this.lease.resolve(backendId, "blob");
    this.work = new PluginWorkOwner(ctx, { code: "tool_output_artifacts", codeReload: true, close: () => {
      this.released = true;
      this.lease.release();
    } });
  }

  put(request: PutToolOutputArtifactRequest): Promise<ToolResultArtifact> {
    return this.work.run(() => this.putAccepted(request));
  }

  get(request: GetToolOutputArtifactRequest): Promise<Uint8Array | undefined> {
    return this.work.run(() => this.getAccepted(request));
  }

  private async putAccepted(request: PutToolOutputArtifactRequest): Promise<ToolResultArtifact> {
    this.assertOpen();
    validatePutRequest(request);
    const reference = await this.blob.put({
      namespace: BLOB_NAMESPACE,
      value: request.value,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    this.assertOpen();
    return Object.freeze({
      kind: "blob",
      locator: encodeLocator(reference),
      metadata: Object.freeze({
        mediaType: request.mediaType,
        bytes: reference.size,
        sha256: reference.sha256,
      }),
    });
  }

  private async getAccepted(
    request: GetToolOutputArtifactRequest,
  ): Promise<Uint8Array | undefined> {
    this.assertOpen();
    const reference = decodeLocator(request?.artifact);
    const value = await this.blob.get({
      reference,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    this.assertOpen();
    return value;
  }

  private assertOpen(): void {
    if (this.released || this.lease.released) {
      throw new StorageClosedError(this.lease.id, "blob");
    }
  }
}

function validatePutRequest(request: PutToolOutputArtifactRequest): void {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Tool output artifact request must be an object");
  }
  requireIdentifier(request.sessionId, "sessionId");
  requireIdentifier(request.runId, "runId");
  requireIdentifier(request.userTurnId, "userTurnId");
  requireIdentifier(request.stepId, "stepId");
  requireIdentifier(request.toolCallId, "toolCallId");
  requireIdentifier(request.toolName, "toolName");
  requireIdentifier(request.mediaType, "mediaType");
  if (!(request.value instanceof Uint8Array)) {
    throw new TypeError("Tool output artifact value must be a Uint8Array");
  }
}

function encodeLocator(reference: BlobReference): string {
  return LOCATOR_PREFIX + Buffer.from(JSON.stringify(reference)).toString("base64url");
}

function decodeLocator(artifact: ToolResultArtifact): BlobReference {
  if (
    artifact === null || typeof artifact !== "object" ||
    artifact.kind !== "blob" || typeof artifact.locator !== "string" ||
    !artifact.locator.startsWith(LOCATOR_PREFIX)
  ) {
    throw new TypeError("Tool output artifact reference is unsupported");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(artifact.locator.slice(LOCATOR_PREFIX.length), "base64url")
        .toString("utf8"),
    ) as unknown;
  } catch (error: unknown) {
    throw new TypeError("Tool output artifact locator is malformed", { cause: error });
  }
  if (!isRecord(value)) {
    throw new TypeError("Tool output artifact locator must contain an object");
  }
  const namespace = requireIdentifier(value.namespace, "artifact namespace");
  const locator = requireIdentifier(value.locator, "artifact Blob locator");
  const sha256 = requireSha256(value.sha256);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new TypeError("Tool output artifact size is invalid");
  }
  if (namespace !== BLOB_NAMESPACE) {
    throw new TypeError("Tool output artifact namespace is unsupported");
  }
  return Object.freeze({
    namespace,
    locator,
    sha256,
    size: value.size as number,
  });
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`Tool output artifact ${label} must be non-empty trimmed text`);
  }
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Tool output artifact SHA-256 is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default BlobToolOutputArtifacts;
