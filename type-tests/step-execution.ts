import { Runtime, type StepPipeline, type StepPipelineSource } from "../src/core/runtime/runtime.js";
import { StepExecutionCoordinator } from "../src/composition/step-execution.js";

const pipeline: StepPipeline<unknown, string, number, string> = {
  async execute({ memory }) { return { status: "completed", result: String(memory) }; },
};
const coordinator = new StepExecutionCoordinator();
const source: StepPipelineSource<unknown, string, number, string> = coordinator.source(() => ({ pipeline, release() {} }));
new Runtime({ stepPipeline: pipeline });
new Runtime({ stepPipeline: source });
coordinator.replace(async () => {}, { signal: new AbortController().signal });
// @ts-expect-error Binding does not own Run state or expose Run controls.
coordinator.control("agent", "run", { type: "abort" });
// @ts-expect-error Core acquisition provides a cancellation signal, not Cordis or mutable Run state.
source.acquire({ signal: new AbortController().signal, run: {} });
// @ts-expect-error Observation cannot be used to set a false idle state.
coordinator.snapshot().activeSteps = 0;
