import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  snapshotCatalog,
  type ModelCatalogSnapshot,
  type ModelCatalogStore,
} from "../catalog.js";

export interface FileCatalogStoreOptions {
  readonly path: string;
  readonly temporaryId?: () => string;
}

/** JSON file store using write-new-temp plus same-directory atomic rename. */
export class FileCatalogStore implements ModelCatalogStore {
  private readonly temporaryId: () => string;

  constructor(private readonly options: FileCatalogStoreOptions) {
    if (
      typeof options.path !== "string" || options.path.length === 0 ||
      options.path.endsWith("/")
    ) throw new Error("Catalog Store path must identify a file");
    this.temporaryId = options.temporaryId ?? (() =>
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
  }

  async load(): Promise<ModelCatalogSnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch (error: unknown) {
      if (isFileError(error, "ENOENT")) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Model Catalog Store contains invalid JSON");
    }
    return snapshotCatalog(parsed);
  }

  async save(snapshot: ModelCatalogSnapshot): Promise<void> {
    const stable = snapshotCatalog(snapshot);
    const directory = parentDirectory(this.options.path);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.options.path}.tmp-${this.temporaryId()}`;
    let temporaryExists = false;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(stable, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      temporaryExists = true;
      await rename(temporaryPath, this.options.path);
      temporaryExists = false;
    } finally {
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Preserve the authoritative write error; stale temp files are non-authoritative.
        }
      }
    }
  }
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return ".";
  return separator === 0 ? "/" : path.slice(0, separator);
}

function isFileError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code?: unknown }).code === code;
}
