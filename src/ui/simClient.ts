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

  // A second worker for what-if checks, so sliders stay responsive during a full run.
  let quickWorker: Worker | undefined;
  let nextQuickId = 1;
  let pendingQuick: { id: number; resolve: (r: QuickResult | null) => void } | undefined;
  // A third worker for the earliest stop-work age search, so it runs alongside the main run.
  let retireWorker: Worker | undefined;
  let nextRetireId = 1;
  let pendingRetire: { id: number; resolve: (v: RetireAgeValue | null) => void } | undefined;
  const createRetireWorker = () => {
    const w = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'pong' || !pendingRetire || msg.requestId !== pendingRetire.id) return;
      const p = pendingRetire;
      pendingRetire = undefined;
      p.resolve(msg.type === 'retireAge' ? msg.value : null);
    };
    return w;
  };
  const createQuickWorker = () => {
    const w = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'pong' || !pendingQuick || msg.requestId !== pendingQuick.id) return;
      const p = pendingQuick;
      pendingQuick = undefined;
      p.resolve(msg.type === 'quickResult' ? msg.result : null);
    };
    return w;
  };

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
    quick(scenario, config) {
      quickWorker ??= createQuickWorker();
      const id = nextQuickId++;
      // Only the latest what-if matters: resolve any earlier pending one with null.
      pendingQuick?.resolve(null);
      return new Promise((resolve) => {
        pendingQuick = { id, resolve };
        quickWorker?.postMessage({ type: 'quick', requestId: id, scenario, config } satisfies WorkerRequest);
      });
    },
    retireAge(scenario, config) {
      retireWorker ??= createRetireWorker();
      const id = nextRetireId++;
      pendingRetire?.resolve(null);
      return new Promise((resolve) => {
        pendingRetire = { id, resolve };
        retireWorker?.postMessage({ type: 'retire', requestId: id, scenario, config } satisfies WorkerRequest);
      });
    },
    ping() {
      return new Promise((resolve) => {
        pongWaiters.push(resolve);
        send({ type: 'ping' });
      });
    },
  };
}
