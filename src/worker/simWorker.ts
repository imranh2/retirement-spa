import { createSimulation, earliestRetirementAgeSteps, MAX_SPEND_STEPS, maxSustainableSpendSteps, quickCheck, quickMaxSpendSteps } from '../engine/simulate';
import type { WorkerRequest, WorkerResponse } from '../model/workerMessages';
import { QUICK_CHECK_RUNS } from '../engine/constants';

/** Runs per chunk; the worker posts progress and checks for cancellation between chunks. */
export const WORKER_CHUNK_RUNS = 500;

/** The parts of the worker global scope used here (avoids mixing DOM and WebWorker libs). */
interface WorkerScope {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
const cancelled = new Set<number>();
let latest = 0;
let latestRetire = 0;
let latestSpend = 0;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

/** Let queued messages (e.g. cancel) be handled between chunks. */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const isCancelled = (id: number) => cancelled.has(id) || id !== latest;

async function run(req: Extract<WorkerRequest, { type: 'run' }>): Promise<void> {
  const { requestId, scenario, config } = req;
  const started = performance.now();
  try {
    const sim = createSimulation(scenario, config);
    for (let from = 0; from < sim.totalRuns; from += WORKER_CHUNK_RUNS) {
      sim.runChunk(from, from + WORKER_CHUNK_RUNS);
      post({ type: 'progress', requestId, completed: Math.min(from + WORKER_CHUNK_RUNS, sim.totalRuns), total: sim.totalRuns });
      await yieldToEvents();
      if (isCancelled(requestId)) { post({ type: 'cancelled', requestId }); return; }
    }
    post({ type: 'result', requestId, result: sim.finish(performance.now() - started) });
    // The max-spend search is ~16 simulations; check for cancellation (or a newer run) after each one.
    const steps = maxSustainableSpendSteps(scenario, config);
    post({ type: 'maxSpendProgress', requestId, completed: 0, total: MAX_SPEND_STEPS });
    for (;;) {
      await yieldToEvents();
      if (isCancelled(requestId)) { post({ type: 'cancelled', requestId }); return; }
      const n = steps.next();
      if (n.done) { post({ type: 'maxSpend', requestId, value: { ...n.value.value, warnings: n.value.warnings } }); return; }
      post({ type: 'maxSpendProgress', requestId, completed: n.value, total: MAX_SPEND_STEPS });
    }
  } catch (e) {
    post({ type: 'error', requestId, message: e instanceof Error ? e.message : String(e) });
  } finally {
    cancelled.delete(requestId);
  }
}

/**
 * Earliest stop-work age search. It runs in its own worker instance alongside the main run,
 * and stops between simulations once a newer search has been requested.
 */
async function retire(req: Extract<WorkerRequest, { type: 'retire' }>): Promise<void> {
  const { requestId, scenario, config } = req;
  try {
    const steps = earliestRetirementAgeSteps(scenario, config);
    for (;;) {
      await yieldToEvents();
      if (requestId !== latestRetire) return;
      const n = steps.next();
      if (n.done) { post({ type: 'retireAge', requestId, value: n.value }); return; }
    }
  } catch (e) {
    post({ type: 'error', requestId, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Quick max-spend search for the what-if panel; stops once a newer one is requested. */
async function spend(req: Extract<WorkerRequest, { type: 'spend' }>): Promise<void> {
  const { requestId, scenario, config } = req;
  try {
    const steps = quickMaxSpendSteps(scenario, config);
    for (;;) {
      await yieldToEvents();
      if (requestId !== latestSpend) return;
      const n = steps.next();
      if (n.done) { post({ type: 'spendResult', requestId, value: { ...n.value.value, warnings: n.value.warnings } }); return; }
    }
  } catch (e) {
    post({ type: 'error', requestId, message: e instanceof Error ? e.message : String(e) });
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'ping') post({ type: 'pong' });
  else if (msg.type === 'cancel') cancelled.add(msg.requestId);
  else if (msg.type === 'quick') {
    // What-if checks run in their own worker instance, one at a time, so no chunking is needed.
    try { post({ type: 'quickResult', requestId: msg.requestId, result: quickCheck(msg.scenario, msg.config, QUICK_CHECK_RUNS) }); }
    catch (err) { post({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) }); }
  } else if (msg.type === 'retire') {
    latestRetire = msg.requestId;
    void retire(msg);
  } else if (msg.type === 'spend') {
    latestSpend = msg.requestId;
    void spend(msg);
  } else if (msg.type === 'run') {
    latest = msg.requestId;
    void run(msg);
  }
};
