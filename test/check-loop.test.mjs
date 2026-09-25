import test from "node:test";
import assert from "node:assert/strict";
import { parseLoopInterval, runCheckerLoop } from "../scripts/check-loop.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("loop interval defaults to 30 minutes and accepts bounded whole minutes", () => {
  assert.equal(parseLoopInterval(undefined), 30 * 60_000);
  assert.equal(parseLoopInterval("1"), 60_000);
  assert.equal(parseLoopInterval("30.0"), 30 * 60_000);
  assert.equal(parseLoopInterval("1.44e3"), 1_440 * 60_000);
});

test("loop interval rejects blank, malformed, out-of-range and non-integer values", () => {
  for (const value of ["", " ", "garbage", "0", "-1", "0.5", "1441", "Infinity", "NaN", "0x10", true, null]) {
    assert.throws(() => parseLoopInterval(value), /OW_INTERVAL_MIN/);
  }
});

test("loop validates its interval before running the checker", async () => {
  let calls = 0;
  await assert.rejects(runCheckerLoop({ run: () => { calls++; }, intervalMin: "0" }), /OW_INTERVAL_MIN/);
  assert.equal(calls, 0);
});

test("loop awaits each run before sleeping and never overlaps runs", async () => {
  const controller = new AbortController();
  const first = deferred();
  const second = deferred();
  const enteredFirst = deferred();
  const enteredSecond = deferred();
  const sleeps = [];
  let calls = 0;
  const loop = runCheckerLoop({
    intervalMin: "2",
    signal: controller.signal,
    run: () => {
      calls++;
      if (calls === 1) { enteredFirst.resolve(); return first.promise; }
      enteredSecond.resolve();
      return second.promise;
    },
    sleep: (ms) => { sleeps.push(ms); },
  });

  await enteredFirst.promise;
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
  first.resolve();
  await enteredSecond.promise;
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [120_000]);
  controller.abort();
  second.resolve();
  await loop;
  assert.deepEqual(sleeps, [120_000]);
});

test("loop reports a failed pass and continues after the interval", async () => {
  const controller = new AbortController();
  const errors = [];
  const sleeps = [];
  let calls = 0;
  await runCheckerLoop({
    run: () => {
      calls++;
      if (calls === 1) throw new Error("weather offline");
      controller.abort();
    },
    signal: controller.signal,
    intervalMin: 1,
    sleep: (ms) => { sleeps.push(ms); },
    onError: (error) => { errors.push(error.message); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(errors, ["weather offline"]);
  assert.deepEqual(sleeps, [60_000]);
});

test("abort during sleep exits without another checker pass", async () => {
  const controller = new AbortController();
  const enteredSleep = deferred();
  let calls = 0;
  const loop = runCheckerLoop({
    run: () => { calls++; },
    signal: controller.signal,
    sleep: () => { enteredSleep.resolve(); return new Promise(() => {}); },
  });
  await enteredSleep.promise;
  controller.abort();
  await loop;
  assert.equal(calls, 1);
});

test("an already aborted loop performs no checker pass", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await runCheckerLoop({ run: () => { calls++; }, signal: controller.signal });
  assert.equal(calls, 0);
});
