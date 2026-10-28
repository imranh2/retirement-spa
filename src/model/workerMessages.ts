import type { Scenario, SimulationResult } from './types';
import type { ConfigBundle } from '../config/configTypes';
import type { RetireAgeOutcome } from './retirement';

/** Messages from the UI to the simulation worker. */
export type WorkerRequest =
  | { type: 'run'; requestId: number; scenario: Scenario; config: ConfigBundle }
  | { type: 'cancel'; requestId: number }
  | { type: 'quick'; requestId: number; scenario: Scenario; config: ConfigBundle }
  | { type: 'retire'; requestId: number; scenario: Scenario; config: ConfigBundle }
  | { type: 'ping' };

export interface MaxSpendValue { multiplier: number; annualSpendReal: number; targetSuccessRate: number; warnings: string[] }
/** Earliest stop-work age at the target success rate . */
export type RetireAgeValue = RetireAgeOutcome;
/** A quick what-if result: enough for a success rate and how long the money lasts. */
export type QuickResult = Pick<SimulationResult, 'ages' | 'runs' | 'successRate' | 'depletionAgeHistogram'>;

/** Messages from the worker to the UI. */
export type WorkerResponse =
  | { type: 'progress'; requestId: number; completed: number; total: number }
  | { type: 'result'; requestId: number; result: SimulationResult }
  | { type: 'maxSpendProgress'; requestId: number; completed: number; total: number }
  | { type: 'maxSpend'; requestId: number; value: MaxSpendValue }
  | { type: 'retireAge'; requestId: number; value: RetireAgeValue }
  | { type: 'quickResult'; requestId: number; result: QuickResult }
  | { type: 'error'; requestId: number; message: string }
  | { type: 'cancelled'; requestId: number }
  | { type: 'pong' };
