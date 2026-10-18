/**
 * Multijogador Clássico (FR-12.2): one card, every player at once, on one clock.
 *
 * The load-bearing test is the first one after the presets: nothing that goes
 * on the room document — which every player can read (D-87) — names the answer
 * to the challenge on screen. The rest is the clock and the arithmetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpsError } from "firebase-functions/v2/https";
import { buildCard, type CardItem } from "../src/lib/card";
import { gdpFor } from "../src/lib/countries";
import { kindById } from "../src/lib/kinds";
import { joinRoom, newRoom, type Room } from "../src/lib/room";
import {
  classicGiveUp, classicGuess, classicMine, classicRanking, presetById, secondsFor, speedPoints, startClassic, tickClassic,
  REVEAL_MS, MULTIPLAYER_PRESETS, type ClassicSecrets,
} from "../src/lib/multiplayer";

const T0 = 1_800_000_000_000;

const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof HttpsError, `expected HttpsError, got ${String(e)}`);
    assert.deepEqual(e.details, { code });
    return true;
  });

/** Seeded so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
}

const right = (item: CardItem) => (item.kind === "gdp" ? gdpFor(item.subject)! : item.options ? item.options.indexOf(item.subject) : item.subject);
const wrong = (item: CardItem) =>
  item.kind === "gdp" ? gdpFor(item.subject)! * 50 : item.options ? (item.options.indexOf(item.subject) + 1) % item.options.length : item.subject === "BR" ? "AR" : "BR";

function room3(presetId: string): Room {
  let r = newRoom("a", "Ana", "classic", presetId, T0);
  r = joinRoom(r, "b", "Bia", T0);
  return joinRoom(r, "c", "Caio", T0);
}

test("every preset resolves and every Clássico preset builds a card", () => {
  for (const p of MULTIPLAYER_PRESETS) {
    assert.equal(presetById(p.id), p);
    if (p.mode === "classic") assert.ok(buildCard(p.spec!, new Set(), rng(7)).length > 0, p.id);
    else assert.equal(p.spec, undefined);
  }
  rejects(() => presetById("nope"), "invalid-argument");
});

test("SEC-1: nothing on the room document or an open prompt names the answer", () => {
  for (const p of MULTIPLAYER_PRESETS.filter((x) => x.mode === "classic")) {
    for (let seed = 1; seed <= 5; seed++) {
      const items = buildCard(p.spec!, new Set(), rng(seed));
      let { room, secrets, prompt } = startClassic(room3(p.id), items, T0);
      for (let i = 0; i < items.length; i++) {
        const subject = items[i]!.subject;
        const roomJson = JSON.stringify(room);
        for (const it of items) assert.ok(!roomJson.includes(`"${it.subject}"`), `${p.id}: room names ${it.subject}`);
        assert.deepEqual(prompt.prompt, kindById(items[i]!.kind).prompt(items[i]!));
        assert.equal(prompt.reveal, null);
        assert.ok(!JSON.stringify(prompt).includes(`"${subject}"`), `${p.id}: prompt names ${subject}`);
        // Close the question, then open the next one.
        const closed = tickClassic(room, secrets, room.classic!.deadline)!;
        assert.equal(closed.reveal!.code, subject);
        const next = tickClassic(closed.room, closed.secrets, closed.room.classic!.deadline)!;
        room = next.room;
        secrets = next.secrets;
        if (next.prompt) prompt = next.prompt;
      }
      assert.equal(room.state, "finished");
    }
  }
});

test("speed only adds to a solve: ×1.5 at once, ×1 at the buzzer, and zero stays zero", () => {
  assert.equal(speedPoints(6, T0, T0, T0 + 45_000), 9);
  assert.equal(speedPoints(6, T0 + 45_000, T0, T0 + 45_000), 6);
  assert.equal(speedPoints(4, T0 + 22_500, T0, T0 + 45_000), 5);
  assert.equal(speedPoints(0, T0, T0, T0 + 45_000), 0);
});

function setup(): { room: Room; secrets: ClassicSecrets; items: CardItem[] } {
  const items: CardItem[] = [{ kind: "capital", subject: "PE" }, { kind: "capital", subject: "FR" }];
  const { room, secrets } = startClassic(room3("capitais"), items, T0);
  return { room, secrets, items };
}

test("a solve closes the item for that player only; they wait for the room", () => {
  let { room, secrets } = setup();
  ({ room, secrets } = classicGuess(room, secrets, "a", "PE", T0 + 3_000));
  assert.deepEqual(room.classic!.progress.a, { guesses: 1, done: true, solved: true, points: null });
  assert.equal(room.classic!.phase, "question");
  rejects(() => classicGuess(room, secrets, "a", "FR", T0 + 4_000), "already-completed");
  assert.deepEqual(classicMine(room, secrets, "a")!.solved, true);
});

test("a guess after the deadline is refused by the server's clock", () => {
  const { room, secrets } = setup();
  rejects(() => classicGuess(room, secrets, "a", "PE", room.classic!.deadline), "time-up");
});

test("the deadline gives up for whoever is still at it, then scores the room", () => {
  let { room, secrets } = setup();
  const d = room.classic!.deadline;
  ({ room, secrets } = classicGuess(room, secrets, "a", "PE", T0)); // instant: 6 × 1.5
  ({ room, secrets } = classicGuess(room, secrets, "b", "BR", T0 + 1_000)); // wrong, still open
  assert.equal(tickClassic(room, secrets, d - 1), null); // not due: a no-op
  const t = tickClassic(room, secrets, d)!;
  assert.equal(t.room.classic!.phase, "reveal");
  assert.equal(t.room.classic!.deadline, d + REVEAL_MS);
  assert.equal(t.room.players.a!.score, 9);
  assert.equal(t.room.players.b!.score, 0);
  assert.equal(t.room.players.c!.score, 0);
  assert.deepEqual(t.room.classic!.progress.b, { guesses: 1, done: true, solved: false, points: 0 });
  assert.equal(t.reveal!.code, "PE");
});

test("when everyone is done the item closes at once, without waiting for the clock", () => {
  let { room, secrets } = setup();
  ({ room, secrets } = classicGuess(room, secrets, "a", "PE", T0 + 1_000));
  ({ room, secrets } = classicGiveUp(room, secrets, "b", T0 + 2_000));
  const r = classicGuess(room, secrets, "c", "PE", T0 + 22_500);
  assert.equal(r.room.classic!.phase, "reveal");
  assert.equal(r.reveal!.code, "PE");
  assert.equal(r.room.players.c!.score, 8); // 6 × (1 + 0.5 × 0.5) = 7.5 → 8
});

test("after the reveal the next challenge opens for everyone; after the last, the game is over", () => {
  let { room, secrets } = setup();
  let t = tickClassic(room, secrets, room.classic!.deadline)!;
  t = tickClassic(t.room, t.secrets, t.room.classic!.deadline)!;
  assert.equal(t.room.classic!.index, 1);
  assert.equal(t.room.classic!.phase, "question");
  assert.equal(t.room.classic!.durationMs, secondsFor("capital") * 1000);
  assert.equal(t.prompt!.index, 1);
  ({ room, secrets } = classicGuess(t.room, t.secrets, "b", "FR", t.room.classic!.startedAt + 100));
  t = tickClassic(room, secrets, room.classic!.deadline)!;
  t = tickClassic(t.room, t.secrets, t.room.classic!.deadline)!;
  assert.equal(t.room.state, "finished");
  assert.deepEqual(classicRanking(t.room)[0], "b");
});

test("ranking: most points, then least time solving", () => {
  let { room, secrets } = setup();
  ({ room, secrets } = classicGuess(room, secrets, "a", "PE", T0 + 5_000));
  ({ room, secrets } = classicGuess(room, secrets, "b", "PE", T0 + 4_000));
  ({ room, secrets } = classicGuess(room, secrets, "c", "BR", T0 + 4_000));
  const t = tickClassic(room, secrets, room.classic!.deadline)!;
  assert.equal(t.room.players.a!.score, t.room.players.b!.score);
  assert.deepEqual(classicRanking(t.room), ["b", "a", "c"]);
});

test("the right and wrong guesses this file uses are right and wrong for every kind", () => {
  for (const p of MULTIPLAYER_PRESETS.filter((x) => x.mode === "classic")) {
    for (const item of buildCard(p.spec!, new Set(), rng(3))) {
      const kind = kindById(item.kind);
      assert.ok(kind.grade(item, right(item), (null as never)).correct, `${item.kind} right`);
      assert.ok(!kind.grade(item, wrong(item), (null as never)).correct, `${item.kind} wrong`);
    }
  }
});

test("training is a Batata Quente for one (D-93)", () => {
  assert.deepEqual(presetById("treino"), { id: "treino", mode: "potato", solo: true });
  assert.ok(MULTIPLAYER_PRESETS.filter((p) => p.solo).every((p) => p.mode === "potato" && !p.spec));
});
