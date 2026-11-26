import { StorageHub } from "../../dist/storage/service.js";
import { StorageBackendService } from "../../dist/storage/binding.js";
import { FileStorageBackend } from "../../dist/storage/providers/file/backend.js";

export async function installSkillsStorage(ctx, directory) {
  await ctx.plugin(StorageHub);
  ctx.storage.register(new FileStorageBackend({ id: "file", rootDirectory: directory }));
  class Selected extends StorageBackendService { static inject = ["storage"]; id = "file"; }
  await ctx.plugin(Selected);
}
