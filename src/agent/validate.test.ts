import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySeen, remember, problems } from "./validate.ts";

const seen = emptySeen();
remember(seen, `People who know module src/serializers, ranked:
1. @swilly22: authored 38 merged PRs here (31 in the last 18 months, last on 2026-10-14), reviewed 15. Recent: #3342 "4.22.1"`);

test("an answer built from the evidence passes", () => {
  assert.deepEqual(problems("Ask @swilly22: 38 merged PRs in src/serializers, 31 of them recent, most recently #3342 on 2026-10-14.", seen), []);
});

test("invented PRs, people and numbers are caught", () => {
  assert.deepEqual(problems("Ask @gkorland, who wrote #9999 and 40 PRs.", seen), [
    "#9999 was not in any tool result",
    "@gkorland was not in any tool result",
    "the number 40 was not in any tool result",
  ]);
});

test("logins are matched without case; paths and dates are not number claims", () => {
  assert.deepEqual(problems("@SWILLY22 owns src/v4/utf8 since 2026-10-14.", seen), []);
});
