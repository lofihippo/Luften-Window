// Scheduling for the long-running checker. Keep the interval validation and
// run/sleep sequencing independent of the CLI so shutdown can be tested.
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_INTERVAL_MIN = 30;
const MAX_INTERVAL_MIN = 24 * 60;

/** Return a bounded timer delay in milliseconds for OW_INTERVAL_MIN. */
export function parseLoopInterval(raw = DEFAULT_INTERVAL_MIN) {
  const validText = typeof raw === "string" &&
    /^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim());
  if (typeof raw !== "number" && !validText) {
    throw new Error(`Invalid OW_INTERVAL_MIN: expected a whole number from 1 to ${MAX_INTERVAL_MIN}`);
  }
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MIN) {
    throw new Error(`Invalid OW_INTERVAL_MIN: expected a whole number from 1 to ${MAX_INTERVAL_MIN}`);
  }
  return minutes * 60_000;
}

async function waitForNextRun(ms, sleep, signal) {
  if (!signal) {
    await sleep(ms, { signal });
    return;
  }
  if (signal.aborted) return;

  // The abort race also handles injected sleep functions that ignore signals.
  let resolveAbort;
  const aborted = new Promise((resolve) => { resolveAbort = resolve; });
  const onAbort = () => resolveAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([Promise.resolve().then(() => sleep(ms, { signal })), aborted]);
  } catch (error) {
    if (!(signal.aborted && error?.name === "AbortError")) throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run immediately, then sleep after each completed pass. A failed pass is
 * reported and retried after the interval. Abort stops after an in-flight pass
 * or immediately during sleep; no checker runs overlap.
 */
export async function runCheckerLoop({
  run,
  intervalMin = DEFAULT_INTERVAL_MIN,
  signal,
  sleep = (ms, { signal: sleepSignal }) => delay(ms, undefined, { signal: sleepSignal }),
  onError = (error) => console.error(`check: ERROR ${error?.message || error}`),
} = {}) {
  const intervalMs = parseLoopInterval(intervalMin);
  if (typeof run !== "function") throw new TypeError("Checker loop requires a run function");

  while (!signal?.aborted) {
    try {
      await run({ signal });
    } catch (error) {
      if (signal?.aborted && error?.name === "AbortError") break;
      onError(error);
    }
    if (signal?.aborted) break;
    await waitForNextRun(intervalMs, sleep, signal);
  }
}
