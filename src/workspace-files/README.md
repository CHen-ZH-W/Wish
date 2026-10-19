# Workspace Files

`WorkspaceFilesService` owns the browser-safe, read-only projection of one Session workspace. The WebUI adapter resolves `Session.scope`, while the Provider bounds each directory listing and text preview, hides protected filesystem names, and rejects absolute paths, `..`, and every symbolic link.

This is human inspection authority, not a model Tool grant. It does not add write operations and does not persist a second workspace registry.

The browser shows one fixed workspace-path toolbar above a single expandable tree. Loaded levels and expansion state remain in place during refresh. Selecting a text file replaces the tree body with a read-only preview; the back action returns to the tree.
