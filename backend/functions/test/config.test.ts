import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ORIGINS,
  MAX_GUESSES,
  PUZZLE_ROLLOVER_HOUR,
  PUZZLE_TIMEZONE,
  REGION,
} from "../src/lib/config";

// These constants are load-bearing for requirements that no other test can see
// fail. A wrong value here does not crash anything — it silently violates a
// requirement in production, which is the worst kind of bug to ship.

test("SEC-9: CORS allowlist contains no wildcard and no plain-http public origin", () => {
  assert.ok(ALLOWED_ORIGINS.length > 0, "an empty allowlist would block the real site");
  for (const origin of ALLOWED_ORIGINS) {
    assert.ok(!origin.includes("*"), `wildcard origin defeats SEC-9: ${origin}`);
    const isLocal = origin.includes("localhost") || origin.includes("127.0.0.1");
    assert.ok(
      origin.startsWith("https://") || isLocal,
      `non-https origin must be localhost only: ${origin}`,
    );
  }
});

test("SEC-9: the production origin is the real site", () => {
  assert.ok(ALLOWED_ORIGINS.includes("https://lisecki.dev"));
});

test("OQ-2: the puzzle day flips at noon in Sao Paulo", () => {
  assert.equal(PUZZLE_TIMEZONE, "America/Sao_Paulo");
  assert.equal(PUZZLE_ROLLOVER_HOUR, 12);
});

test("OQ-2: the timezone is one the runtime actually knows", () => {
  // A typo here would silently fall back to UTC and shift every puzzle by 3h.
  assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: PUZZLE_TIMEZONE }));
  const resolved = new Intl.DateTimeFormat("en", { timeZone: PUZZLE_TIMEZONE })
    .resolvedOptions().timeZone;
  assert.equal(resolved, PUZZLE_TIMEZONE);
});

test("FR-2.5: six guesses", () => {
  assert.equal(MAX_GUESSES, 6);
});

test("D-9 / architecture: everything lives in southamerica-east1", () => {
  assert.equal(REGION, "southamerica-east1");
});
