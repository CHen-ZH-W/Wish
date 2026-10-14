import type { Context } from "@deepseek-ai/cordis";

import {
  registerManagedWebUiControl,
  WebUiControlError,
  type WebUiControl,
} from "../../apps/webui/controls.js";
import type { ModelRef } from "../../core/model/model.js";
import { StorageConflictError } from "../../storage/errors.js";
import { ModelsConfigurationError } from "../config.js";
import {
  ModelReasoningSelectionError,
  type SessionReasoningPort,
} from "../session-reasoning.js";
import type { ModelReasoningEffort } from "../types.js";

export const MODEL_REASONING_WEBUI_CONTROL = "model-reasoning";

/** Models owns its WebUI transport adapter; the generic server never parses this contract. */
export function createModelReasoningWebUiControl(): WebUiControl {
  const control: WebUiControl = {
    inspectDefault(application) {
      return translate(() => requireReasoning(application.sessionReasoning).inspectDefault());
    },
    inspectSession(application, sessionId, signal) {
      return translate(async () => {
        const reasoning = requireReasoning(application.sessionReasoning);
        return reasoning.inspect(sessionId, reasoning.defaultModel(), signal);
      });
    },
    updateSession(application, sessionId, body, signal) {
      return translate(async () => {
        requireOnlyKeys(body, ["model", "effort"]);
        const reasoning = requireReasoning(application.sessionReasoning);
        const current = reasoning.defaultModel();
        const submitted = modelReference(body.model);
        if (submitted.provider !== current.provider || submitted.model !== current.model) {
          throw new WebUiControlError(409, "model_selection_changed", "Default model changed; reload the reasoning choices");
        }
        return reasoning.select(sessionId, current, reasoningEffort(body.effort), signal);
      });
    },
  };
  return Object.freeze(control);
}

function requireReasoning(value: SessionReasoningPort | undefined): SessionReasoningPort {
  if (value === undefined) {
    throw new WebUiControlError(503, "model_reasoning_unavailable", "Session reasoning selection is unavailable");
  }
  return value;
}

async function translate<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WebUiControlError) throw error;
    if (error instanceof ModelReasoningSelectionError) {
      throw new WebUiControlError(409, "model_reasoning_unsupported", "Selected model does not support this reasoning effort");
    }
    if (error instanceof StorageConflictError) {
      throw new WebUiControlError(409, "model_selection_conflict", "Reasoning choice changed concurrently; reload and try again");
    }
    if (error instanceof ModelsConfigurationError) {
      throw new WebUiControlError(400, "invalid_model", error.message);
    }
    throw error;
  }
}

function requireOnlyKeys(body: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(body).some(key => !accepted.has(key)) || allowed.some(key => !(key in body))) {
    throw new WebUiControlError(400, "invalid_request", `Expected only ${allowed.join(", ")}`);
  }
}

function modelReference(value: unknown): ModelRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WebUiControlError(400, "invalid_model", "Model reference is required");
  }
  const model = value as Record<string, unknown>;
  if (Object.keys(model).some(key => key !== "provider" && key !== "model") ||
    typeof model.provider !== "string" || !model.provider || typeof model.model !== "string" || !model.model) {
    throw new WebUiControlError(400, "invalid_model", "Model reference is invalid");
  }
  return Object.freeze({ provider: model.provider, model: model.model });
}

function reasoningEffort(value: unknown): ModelReasoningEffort | null {
  if (value === null || value === "none" || value === "low" || value === "high" || value === "max") return value;
  throw new WebUiControlError(400, "invalid_reasoning_effort", "Reasoning effort must be none, low, high, max, or null");
}

export default {
  name: "models-webui-control",
  inject: ["application", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, MODEL_REASONING_WEBUI_CONTROL, createModelReasoningWebUiControl());
  },
};
