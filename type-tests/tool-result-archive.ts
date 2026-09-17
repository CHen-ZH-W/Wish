import type { ToolResultArchivePort } from "../src/tools/results/types.js";
import type { ToolResultArchiveHandle } from
  "../src/tools/results/service.js";
import { FileToolResultArchive } from
  "../src/tools/results/providers/file.js";

const archive: ToolResultArchivePort = new FileToolResultArchive({
  directory: ".wish/tool-results",
  locatorRoot: ".wish",
});

void archive;

declare const handle: ToolResultArchiveHandle;
const released: boolean = handle.released;
const releaseResult: boolean = handle.release();
void released;
void releaseResult;
