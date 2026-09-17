export interface HostDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly hidden: boolean;
}

export interface HostDirectoryListing {
  readonly path: string;
  readonly crumbs: readonly HostDirectoryEntry[];
  readonly entries: readonly HostDirectoryEntry[];
  readonly truncated: boolean;
  readonly limit: number;
}

export interface HostDirectoryBrowser {
  /** Without a path, start navigation at the Host user's home; do not select a Workspace. */
  list(path?: string, signal?: AbortSignal): Promise<HostDirectoryListing>;
}

export class HostDirectoryBrowseError extends Error {
  constructor(readonly code: "directory_invalid_path" | "directory_unreadable") {
    super(code);
  }
}
