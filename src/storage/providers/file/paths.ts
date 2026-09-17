import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export function fileKvRoot(rootDirectory: string): string {
  return join(rootDirectory, "kv");
}

export function fileKvNamespaceDirectory(
  rootDirectory: string,
  namespace: string,
): string {
  return join(fileKvRoot(rootDirectory), `namespace-${digest(namespace)}`);
}

export function fileKvKeyPath(
  rootDirectory: string,
  namespace: string,
  key: string,
): string {
  return join(
    fileKvNamespaceDirectory(rootDirectory, namespace),
    `key-${digest(key)}.json`,
  );
}

export function fileKvTemporaryPath(
  targetPath: string,
  temporaryId: string,
): string {
  return join(dirname(targetPath), `.tmp-${digest(temporaryId)}.json`);
}

export function fileBlobNamespaceDirectory(
  rootDirectory: string,
  namespace: string,
): string {
  return join(rootDirectory, "blob", `namespace-${digest(namespace)}`);
}

export function fileBlobPath(
  rootDirectory: string,
  namespace: string,
  sha256: string,
): string {
  return join(
    fileBlobNamespaceDirectory(rootDirectory, namespace),
    `sha256-${sha256}.blob`,
  );
}

export function fileBlobTemporaryPath(
  targetPath: string,
  temporaryId: string,
): string {
  return join(dirname(targetPath), `.tmp-${digest(temporaryId)}.blob`);
}

export function fileJournalPath(
  rootDirectory: string,
  namespace: string,
): string {
  return join(rootDirectory, "journal", `journal-${digest(namespace)}.jsonl`);
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
