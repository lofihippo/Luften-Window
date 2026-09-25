import { test } from "node:test";
import assert from "node:assert/strict";
import { dewPoint, rhFrom, cToF, fToC, deltaCtoF } from "../public/core/psychro.js";

test("dewPoint(16.67, 50) ≈ 6.2", () => {
  assert.ok(Math.abs(dewPoint(16.67, 50) - 6.2) < 0.1, `got ${dewPoint(16.67, 50)}`);
});

test("dewPoint(20, 50) ≈ 9.26", () => {
  assert.ok(Math.abs(dewPoint(20, 50) - 9.26) < 0.1, `got ${dewPoint(20, 50)}`);
});

test("rhFrom(20, 20) = 100", () => {
  assert.equal(rhFrom(20, 20), 100);
});

test("rhFrom(20, dewPoint(20, 42)) ≈ 42", () => {
  const dp = dewPoint(20, 42);
  assert.ok(Math.abs(rhFrom(20, dp) - 42) < 0.1, `got ${rhFrom(20, dp)}`);
});

test("cToF(6.2) ≈ 43.2", () => {
  assert.ok(Math.abs(cToF(6.2) - 43.2) < 0.2, `got ${cToF(6.2)}`);
});

test("rhFrom clamps to [0, 100]", () => {
  assert.equal(rhFrom(20, 40), 100); // upper clamp
  const v = rhFrom(30, -120); // extreme low never negative
  assert.ok(v >= 0 && v <= 100, `got ${v}`);
});

test("fToC inverts cToF", () => {
  assert.ok(Math.abs(fToC(cToF(17)) - 17) < 0.01);
});

test("deltaCtoF multiplies by 9/5", () => {
  assert.ok(Math.abs(deltaCtoF(1.5) - 2.7) < 0.01);
});
