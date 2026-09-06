import test from "node:test";
import assert from "node:assert/strict";
import { usdPerMillion, median } from "../src/core/support.js";

test("usdPerMillion parses per-token strings to exact per-M integers", () => {
  assert.equal(usdPerMillion("0.0000008870"), 887_000); // $0.887/M
  assert.equal(usdPerMillion("0"), 0);
  assert.equal(usdPerMillion("0.000001"), 1_000_000); // exactly $1.00/M
  assert.equal(usdPerMillion("0.00000004"), 40_000);
  assert.equal(usdPerMillion(0.000001), 1_000_000);
  assert.equal(usdPerMillion("0.0000012"), 1_200_000);
});

test("usdPerMillion rejects junk", () => {
  for (const bad of [null, undefined, "", "abc", "-1", {}, "1e-6x"]) {
    assert.equal(usdPerMillion(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("median handles odd/even/empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 6]), 5);
  assert.equal(median([]), null);
  assert.equal(median([null, 5]), 5);
});
