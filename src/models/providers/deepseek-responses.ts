import type {
  Model,
  ModelError,
} from "../../core/model/model.js";
import type { ModelAdapterFactoryInput } from "../types.js";
import {
  DeepSeekResponsesRequestError,
  mapDeepSeekResponsesRequest,
} from "./deepseek-responses-request.js";
import { createResponsesApiAdapter } from "./responses-api.js";

import { DEEPSEEK_RESPONSES_PROTOCOL } from "./protocols.js";
export { DEEPSEEK_RESPONSES_PROTOCOL } from "./protocols.js";

/** Dedicated DeepSeek Responses Adapter with native instruction/request mapping. */
export function createDeepSeekResponsesAdapter(
  input: ModelAdapterFactoryInput,
): Model {
  return createResponsesApiAdapter(input, {
    label: "DeepSeek Responses",
    mapRequest: mapDeepSeekResponsesRequest,
    requestError,
  });
}

function requestError(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof DeepSeekResponsesRequestError
      ? error.message
      : "DeepSeek Responses request could not be mapped",
    retryable: false,
  };
}
