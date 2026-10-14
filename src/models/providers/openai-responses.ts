import type { Model, ModelError } from "../../core/model/model.js";
import type { ModelAdapterFactoryInput } from "../types.js";
import {
  mapOpenAIResponsesRequest,
  OpenAIResponsesRequestError,
} from "./openai-responses-request.js";
import { createResponsesApiAdapter } from "./responses-api.js";

import { OPENAI_RESPONSES_PROTOCOL } from "./protocols.js";
export { OPENAI_RESPONSES_PROTOCOL } from "./protocols.js";

export function createOpenAIResponsesAdapter(
  input: ModelAdapterFactoryInput,
): Model {
  return createResponsesApiAdapter(input, {
    label: "OpenAI Responses",
    mapRequest: mapOpenAIResponsesRequest,
    requestError,
  });
}

function requestError(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof OpenAIResponsesRequestError
      ? error.message
      : "OpenAI Responses request could not be mapped",
    retryable: false,
  };
}
