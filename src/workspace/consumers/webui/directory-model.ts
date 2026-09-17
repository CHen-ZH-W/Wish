import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { HostDirectoryEntry, HostDirectoryListing } from "../../directory-picker/types.js";

export interface DirectoryBrowserSnapshot {
  readonly open: boolean;
  readonly listing: HostDirectoryListing | null;
  readonly child: HostDirectoryListing | null;
  readonly selected: string | null;
  readonly loading: boolean;
  readonly childLoading: boolean;
  readonly showHidden: boolean;
  readonly error: string | null;
}

/** Browser-only navigation state. Host remains authoritative for paths and Session creation. */
export class DirectoryBrowserModel extends SnapshotStore<DirectoryBrowserSnapshot> {
  private version = 0;
  private closed = false;
  constructor(private readonly connection: ClientConnection) {
    super({ open: false, listing: null, child: null, selected: null, loading: false, childLoading: false, showHidden: false, error: null });
  }
  open = async (path?: string): Promise<void> => {
    if (this.closed) return;
    this.publish({ open: true, listing: null, child: null, selected: null, loading: true, childLoading: false, showHidden: false, error: null });
    await this.navigate(path);
  };
  dismiss = (): void => {
    this.version++;
    this.publish({ ...this.getSnapshot(), open: false, loading: false, childLoading: false });
  };
  navigate = async (path?: string): Promise<void> => {
    if (this.closed || !this.getSnapshot().open) return;
    const version = ++this.version;
    this.publish({ ...this.getSnapshot(), loading: true, error: null });
    try {
      const { listing } = await this.connection.request<{ listing: HostDirectoryListing }>("/api/workspace/directories", path ? { path } : {});
      if (this.closed || version !== this.version) return;
      this.publish({ ...this.getSnapshot(), listing, child: null, selected: null, loading: false, childLoading: false, error: null });
    } catch (error) {
      if (this.closed || version !== this.version) return;
      this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "directory_unreadable" });
    }
  };
  select = async (entry: HostDirectoryEntry, fromChild = false): Promise<void> => {
    const state = this.getSnapshot();
    if (this.closed || !state.open || !state.listing || (fromChild && !state.child)) return;
    const listing = fromChild ? state.child! : state.listing;
    if (!listing.entries.some(item => item.path === entry.path)) return;
    const version = ++this.version;
    this.publish({ ...state, listing, child: null, selected: entry.path, loading: false, childLoading: true, error: null });
    try {
      const { listing: child } = await this.connection.request<{ listing: HostDirectoryListing }>("/api/workspace/directories", { path: entry.path });
      if (this.closed || version !== this.version) return;
      this.publish({ ...this.getSnapshot(), child, childLoading: false, error: null });
    } catch (error) {
      if (this.closed || version !== this.version) return;
      this.publish({ ...this.getSnapshot(), selected: null, childLoading: false, error: error instanceof Error ? error.message : "directory_unreadable" });
    }
  };
  toggleHidden = (): void => this.publish({ ...this.getSnapshot(), showHidden: !this.getSnapshot().showHidden });
  pickedPath = (): string | null => {
    const state = this.getSnapshot();
    return state.loading || state.childLoading ? null : state.selected ?? state.listing?.path ?? null;
  };
  close(): void { this.closed = true; this.dismiss(); }
}
