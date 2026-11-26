import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FilesystemPolicy } from "./types.js";

export function isPathInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Shared by direct file access, recursive search and process preflight. */
export function isProtectedFilesystemPath(path: string, policy: FilesystemPolicy): boolean {
  const target = resolve(path);
  if (policy.protectedPaths.some(root => isPathInside(root, target))) return true;
  return target.split(/[\\/]+/u).some(name => {
    if (policy.protectedNameExceptions.includes(name)) return false;
    return policy.protectedDirectoryNames.includes(name) || policy.protectedFileNames.includes(name) ||
      policy.protectedFilePrefixes.some(prefix => name.startsWith(prefix));
  });
}

