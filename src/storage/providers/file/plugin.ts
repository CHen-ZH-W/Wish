import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { StorageBackendService } from "../../binding.js";
import { FileStorageBackend } from "./backend.js";
import { registerPluginLifecycle } from "../../../boot/plugin-control/lifecycle.js";

export interface Config {
  readonly id?: string;
  readonly rootDirectory?: string;
  readonly journalTornTailRecovery?: "fail" | "truncate";
}

export const Config: s<Config> = s.object({
  id: s.string(),
  rootDirectory: s.string(),
  journalTornTailRecovery: s.union([
    s.const("fail"),
    s.const("truncate"),
  ]),
});

/** Register and select one File Backend for this provider generation. */
export class FileStorageProvider extends StorageBackendService {
  static readonly inject = ["launch", "storage"];
  static readonly Config = Config;

  readonly id: string;
  readonly file: FileStorageBackend;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.id = config.id ?? "file";
    this.file = new FileStorageBackend({
      id: this.id,
      rootDirectory: resolveRootDirectory(ctx, config.rootDirectory),
      ...(config.journalTornTailRecovery === undefined
        ? {}
        : { journalTornTailRecovery: config.journalTornTailRecovery }),
    });
    const registration = ctx.storage.register(this.file);
    registerPluginLifecycle(ctx, () => {
      const snapshot = registration.snapshot();
      return {
        disposition: snapshot.state !== "active" ? "blocked"
          : snapshot.leases > 0 ? "drain" : "direct",
        code: snapshot.state === "failed" ? "storage_close_failed"
          : snapshot.state === "closed" ? "storage_closed"
          : snapshot.state === "retiring" ? "storage_retiring"
          : snapshot.leases > 0 ? "storage_leases_outstanding" : "storage_idle",
        counts: { leases: snapshot.leases },
      };
    }, () => {
      const resume = registration.suspendAcquisitions();
      let closing: Promise<void> | undefined;
      return {
        release: () => { if (!closing) resume(); },
        close: () => closing ??= registration.unregister().then(() => {}),
      };
    });
  }
}

function resolveRootDirectory(ctx: Context, configured: string | undefined): string {
  if (configured === undefined) {
    return join(ctx.launch.homeDirectory ?? homedir(), ".wish", "storage");
  }
  if (configured.length === 0 || configured !== configured.trim()) {
    throw new TypeError("File Storage rootDirectory must be non-empty trimmed text");
  }
  return resolve(ctx.launch.cwd, configured);
}

export default FileStorageProvider;
