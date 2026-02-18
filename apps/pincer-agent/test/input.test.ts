import test from "node:test";
import assert from "node:assert/strict";

import { parseInputJson } from "../src/input.js";

test("parseInputJson accepts object input", () => {
  const parsed = parseInputJson('{"query":"test","max_results":10}');
  assert.deepEqual(parsed, { query: "test", max_results: 10 });
});

test("parseInputJson rejects invalid JSON", () => {
  assert.throws(() => parseInputJson("{broken"), /--input must be valid JSON/);
});

test("parseInputJson rejects non-object JSON", () => {
  assert.throws(() => parseInputJson("[]"), /--input must parse to a JSON object/);
});
