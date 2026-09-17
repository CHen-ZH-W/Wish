import { Service, type Context } from "@deepseek-ai/cordis";

import type { ToolResultArtifact } from "../../../core/tools/tool.js";
import type {
  GetToolOutputArtifactRequest,
  PutToolOutputArtifactRequest,
  ToolOutputArtifactStore,
} from "./types.js";

/** Definition implemented by replaceable Tool output artifact Providers. */
export abstract class ToolOutputArtifactsService extends Service
  implements ToolOutputArtifactStore {
  constructor(ctx: Context) {
    super(ctx, "toolOutputArtifacts");
  }

  abstract put(request: PutToolOutputArtifactRequest): Promise<ToolResultArtifact>;
  abstract get(request: GetToolOutputArtifactRequest): Promise<Uint8Array | undefined>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    toolOutputArtifacts: ToolOutputArtifactsService;
  }
}

export default ToolOutputArtifactsService;
