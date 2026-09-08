import type { ToolResultArchivePort } from "../src/context/types.js";
import { FileToolResultArchive } from
  "../src/storage/tool-results/file-tool-result-archive.js";

const archive: ToolResultArchivePort = new FileToolResultArchive({
  directory: ".wish/tool-results",
  locatorRoot: ".wish",
});

void archive;
