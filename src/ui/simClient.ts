import type { Scenario, SimulationResult } from '../model/types';
import type { ConfigBundle } from '../config/configTypes';
import type { MaxSpendValue, QuickResult, RetireAgeValue, WorkerRequest, WorkerResponse } from '../model/workerMessages';

export interface RunHandlers {
  onProgress?: (completed: number, total: number) => void;
  onResult?: (result: SimulationResult) => void;
  onMaxSpendProgress?: (completed: number, total: number) => void;
  onMaxSpend?: (value: MaxSpendValue) => void;
  onError?: (message: string) => void;
  onCancelled?: () => void;
}

/** Interface the store uses to run simulations (a fake is used in tests). */
export interface SimRunner {
  run(scenario: Scenario, config: ConfigBundle, handlers: RunHandlers): void;
  cancel(): void;
  /** A quick what-if check on a separate worker; superseded calls resolve to null. */
  quick?(scenario: Scenario, config: ConfigBundle): Promise<QuickResult | null>;
  /** Earliest stop-work age search on its own worker; superseded calls resolve to null. */
  retireAge?(scenario: Scenario, config: ConfigBundle): Promise<RetireAgeValue | null>;
  /** Quick max-spend search for a what-if on its own worker; superseded calls resolve to null. */
  maxSpendAt?(scenario: Scenario, config: ConfigBundle): Promise<MaxSpendValue | null>;
}

/**
 * Client for the simulation Web Worker. Only one run is active at a time: starting a
 * new run cancels the previous one, and messages for stale requests are ignored.
 * The worker is created with the Vite pattern so it bundles under a relative base path.
 */
export function createSimClient(): SimRunner & { ping(): Promise<boolean> } {
  const worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  let active = 0;
  let handlers: RunHandlers = {};
  const pongWaiters: ((ok: boolean) => void)[] = [];

  const send = (msg: WorkerRequest) => worker.postMessage(msg);

  // Extra workers, each created on first use, so what-if checks and searches run alongside
  // the main run: quick success checks, the earliest stop-work age, and the what-if max spend.
  const quickWorker = latestOnlyWorker<QuickResult>((m) => (m.type === 'quickResult' ? m.result : null));
  const retireWorker = latestOnlyWorker<RetireAgeValue>((m) => (m.type === 'retireAge' ? m.value : null));
  const spendWorker = latestOnlyWorker<MaxSpendValue>((m) => (m.type === 'spendResult' ? m.value : null));

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === 'pong') { pongWaiters.splice(0).forEach((w) => w(true)); return; }
    if (msg.requestId !== active) return;
    // Clear `active` before a final handler runs, so a handler that starts a new run keeps its id.
    switch (msg.type) {
      case 'progress': handlers.onProgress?.(msg.completed, msg.total); break;
      case 'result': handlers.onResult?.(msg.result); break;
      case 'maxSpendProgress': handlers.onMaxSpendProgress?.(msg.completed, msg.total); break;
      case 'maxSpend': active = 0; handlers.onMaxSpend?.(msg.value); break;
      case 'error': active = 0; handlers.onError?.(msg.message); break;
      case 'cancelled': active = 0; handlers.onCancelled?.(); break;
    }
  };
  worker.onerror = (e) => {
    handlers.onError?.(e.message || 'The simulation worker failed to start. Serve the app over http (npm run dev / preview), not file://.');
    active = 0;
  };

  return {
    run(scenario, config, h) {
      if (active) send({ type: 'cancel', requestId: active });
      active = nextId++;
      handlers = h;
      send({ type: 'run', requestId: active, scenario, config });
    },
    cancel() {
      if (!active) return;
      send({ type: 'cancel', requestId: active });
    },
    quick: (scenario, config) => quickWorker.request((requestId) => ({ type: 'quick', requestId, scenario, config })),
    retireAge: (scenario, config) => retireWorker.request((requestId) => ({ type: 'retire', requestId, scenario, config })),
    maxSpendAt: (scenario, config) => spendWorker.request((requestId) => ({ type: 'spend', requestId, scenario, config })),
    ping() {
      return new Promise((resolve) => {
        pongWaiters.push(resolve);
        send({ type: 'ping' });
      });
    },
  };
}

/**
 * A simulation worker, created on first request, where only the latest request matters:
 * a new request resolves the previous pending one with null (the worker drops it too).
 * `pick` takes the answer from the worker's reply, or null for an error.
 */
function latestOnlyWorker<T>(pick: (msg: WorkerResponse) => T | null) {
  let worker: Worker | undefined;
  let nextId = 1;
  let pending: { id: number; resolve: (v: T | null) => void } | undefined;
  return {
    request(make: (requestId: number) => WorkerRequest): Promise<T | null> {
      if (!worker) {
        worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data;
          if (msg.type === 'pong' || !pending || msg.requestId !== pending.id) return;
          const p = pending;
          pending = undefined;
          p.resolve(pick(msg));
        };
      }
      const id = nextId++;
      pending?.resolve(null);
      return new Promise((resolve) => {
        pending = { id, resolve };
        worker?.postMessage(make(id));
      });
    },
  };
}
