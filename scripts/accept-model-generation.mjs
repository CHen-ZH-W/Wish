import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateModels,
  MODEL_SOURCE_URLS,
  renderGeneratedModels,
} from "./models/generator.mjs";

const MODELS_DEV_PROVIDERS = [
  "openai",
  "deepseek",
  "anthropic",
  "groq",
  "cerebras",
  "xai",
  "zai-coding-plan",
  "huggingface",
  "fireworks-ai",
  "opencode",
  "opencode-go",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
];

function fixtureSources() {
  const modelsDev = Object.fromEntries(MODELS_DEV_PROVIDERS.map((provider) => {
    const id = provider === "deepseek" ? "deepseek-v4-flash" : `${provider}-model`;
    return [provider, {
      models: {
        [id]: {
          name: `${provider} model`,
          tool_call: true,
          reasoning: provider === "deepseek" || provider === "openai",
          temperature: provider !== "deepseek",
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 8_000 },
          cost: { input: 1, output: 2, cache_read: 0.1 },
          last_updated: "2026-09-07",
        },
        [`${id}-no-tools`]: { tool_call: false },
      },
    }];
  }));
  modelsDev.opencode.models["unsupported-anthropic"] = {
    tool_call: true,
    provider: { npm: "@ai-sdk/anthropic" },
  };
  modelsDev.openai.models["unsupported-realtime"] = {
    tool_call: true,
    modalities: { input: ["text", "audio"], output: ["text", "audio"] },
  };
  return {
    [MODEL_SOURCE_URLS.modelsDev]: modelsDev,
    [MODEL_SOURCE_URLS.openRouter]: {
      data: [{
        id: "vendor/router-model",
        name: "Router Model",
        context_length: 200_000,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 16_000 },
        supported_parameters: [
          "tools",
          "reasoning",
          "temperature",
          "max_completion_tokens",
        ],
        pricing: {
          prompt: "0.000001",
          completion: "0.000002",
          input_cache_read: "0.0000001",
        },
      }, {
        id: "vendor/model-latest",
        supported_parameters: ["tools"],
      }],
    },
    [MODEL_SOURCE_URLS.vercelAiGateway]: {
      data: [{
        id: "vendor/gateway-model",
        name: "Gateway Model",
        context_window: 300_000,
        max_tokens: 32_000,
        tags: ["tool-use", "reasoning", "vision"],
        modalities: { input: ["text", "image"] },
        pricing: { input: "0.000003", output: "0.000004" },
      }],
    },
  };
}

function fixtureFetch(sources, failedUrl) {
  return async (url) => {
    if (url === failedUrl) return new Response("failure", { status: 503 });
    return Response.json(sources[url]);
  };
}

test("generator normalizes all sources deterministically without inventing unsupported models", async () => {
  const sources = fixtureSources();
  const models = await generateModels({ fetch: fixtureFetch(sources) });

  assert.equal(Object.keys(models).length, 17);
  assert.equal(models.openai[0].developerRole, true);
  assert.equal(models.openai.some((model) =>
    model.id === "unsupported-realtime"
  ), false);
  assert.deepEqual(models.deepseek.map(model => model.id), [
    "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro",
  ]);
  assert.equal(models.deepseek[0].input.image, true);
  assert.equal(models.deepseek[0].maxOutputTokens, 393216);
  assert.equal(models.deepseek[0].price, undefined, "tiered current pricing must remain unknown");
  assert.equal(models.deepseek[1].status, "deprecated");
  assert.equal(models.deepseek[2].status, "deprecated");
  assert.equal(models.deepseek[3].input.image, false);
  assert.ok(models.deepseek.every(model => model.price === undefined));
  assert.equal(models.opencode.some((model) =>
    model.id === "unsupported-anthropic"
  ), false);

  const router = models.openrouter[0];
  assert.equal(models.openrouter.length, 1);
  assert.equal(router.input.image, true);
  assert.equal(router.price.inputPerMillionTokens, 1);
  assert.equal(router.request.maxTokensField, "max_completion_tokens");
  assert.deepEqual(router.request.extraBody, {
    reasoning: { effort: "high" },
  });

  const gateway = models["vercel-ai-gateway"][0];
  assert.equal(gateway.reasoning, true);
  assert.equal(gateway.price.outputPerMillionTokens, 4);
  assert.equal(renderGeneratedModels(models), renderGeneratedModels(models));
});

test("generator fails the complete refresh when a required source fails", async () => {
  const sources = fixtureSources();
  await assert.rejects(
    generateModels({
      fetch: fixtureFetch(sources, MODEL_SOURCE_URLS.openRouter),
    }),
    /OpenRouter model source returned an unsuccessful response \(503\)/u,
  );
});

test("official DeepSeek catalog survives stale third-party names and prices", async () => {
  const sources = fixtureSources();
  sources[MODEL_SOURCE_URLS.modelsDev].deepseek.models = {
    "deepseek-v4-pro": { tool_call: true, cost: { input: 999, output: 999 } },
  };
  const models = await generateModels({ fetch: fixtureFetch(sources) });
  assert.equal(models.deepseek[0].id, "deepseek-flash");
  assert.ok(models.deepseek.every(model => model.price === undefined));

  delete sources[MODEL_SOURCE_URLS.modelsDev].deepseek;
  const withoutThirdParty = await generateModels({ fetch: fixtureFetch(sources) });
  assert.deepEqual(withoutThirdParty.deepseek, models.deepseek);
});

test("checked-in DeepSeek snapshot matches the official generator definition", async () => {
  const source = await readFile(new URL("../src/models/models.generated.ts", import.meta.url), "utf8");
  const json = source.split("export const GENERATED_MODELS = ")[1]?.split(" as const satisfies")[0];
  assert.ok(json, "generated file must contain the catalog object");
  const checkedIn = JSON.parse(json);
  const generated = await generateModels({ fetch: fixtureFetch(fixtureSources()) });
  assert.deepEqual(checkedIn.deepseek, generated.deepseek);
});
