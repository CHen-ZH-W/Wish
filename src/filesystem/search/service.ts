import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  FilesystemSearch,
  FilesystemSearchPolicy,
  SearchTextRequest,
  SearchTextResult,
} from "./types.js";

/** Definition consumed by Grep and implemented by replaceable search Providers. */
export abstract class FilesystemSearchService extends Service
  implements FilesystemSearch {
  abstract readonly policy: FilesystemSearchPolicy;

  constructor(ctx: Context) {
    super(ctx, "filesystemSearch");
  }

  abstract search(request: SearchTextRequest): Promise<SearchTextResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    filesystemSearch: FilesystemSearchService;
  }
}

export default FilesystemSearchService;
