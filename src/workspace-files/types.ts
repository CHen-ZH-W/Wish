export interface WorkspaceFileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: string;
}

export interface WorkspaceDirectoryView {
  readonly schemaVersion: 1;
  /** Canonical Session workspace root shown by the human-facing Files pane. */
  readonly root: string;
  readonly path: string;
  readonly entries: readonly WorkspaceFileEntry[];
  readonly truncated: boolean;
}

export interface WorkspaceTextFileView {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface WorkspaceBinaryFileView {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly contentBase64: string;
}

export interface WorkspaceFilesPort {
  list(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceDirectoryView>;
  read(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceTextFileView>;
  readBytes(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceBinaryFileView>;
}
