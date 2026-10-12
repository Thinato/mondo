/**
 * Versus — FR-12. Live rooms, played by everyone at once (D-87, D-88).
 *
 * ONE callable, `versus({ op, … })`, rather than one per action (D-92). Every
 * callable is its own Cloud Run service, and every service has its own cold
 * start: eight of them would mean a game whose first turn, first guess and
 * first tick each wait two seconds — and on a three-second Batata Quente turn
 * that decides the turn. One function is warm after the first call of a game.
 * Each op still validates its own input and runs its own transaction, exactly
 * as a separate callable would; the switch below is the only thing shared.
 *
 * The clients learn what happened by LISTENING (D-87): `rooms/{id}` and its
 * subcollections are readable by the room's players and written only here. So
 * every op answers with little more than `serverNow`, which the client uses to
 * keep its countdown honest, and with whatever is that player's alone.
 *
 * Nothing is scheduled. A deadline is enforced when somebody acts after it: an
 * answer that arrives late is refused by the server's clock, and every client
 * calls `tick` when its own countdown reaches zero. The first tick through the
 * transaction moves the game on and the rest find nothing due.
 *
 * Nothing here reaches `attempts`: a Versus result lives on its room and on no
 * board (FR-12.1, the reason D-40 exists).
 */

import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { dailyAhead, db, ensureProfile, roomRef, roomSecretsRef, roomSubRef } from "./db";
import { requireCanCreateGroup, rankOf } from "./lib/authz";
import { buildCard } from "./lib/card";
import { countryByCode } from "./lib/countries";
import { mondoError } from "./lib/errors";
import { inviteToken } from "./lib/invite";
import { matchCountry } from "./lib/match";
import { applyAnswer, applyTimeout, checkTurn, giveUpPotato, newPotato, type PotatoState } from "./lib/potato";
import { parseSelfReport } from "./lib/report";
import { joinRoom, leaveRoom, newRoom, requirePlayer, requirePlaying, requireStartable, type PromptDoc, type Room } from "./lib/room";
import { callable, signInProvider } from "./lib/callable";
import { GUESS_MIN_INTERVAL_MS } from "./lib/config";
import { requireInviteToken, requireObject } from "./lib/validate";
import {
  classicGiveUp, classicGuess, classicMine, presetById, startClassic, tickClassic, type ClassicSecrets,
} from "./lib/versus";
import { mapBase, mapPiece } from "./lib/world";

/** At most this many queued names in one `answer` (FR-12.3). */
export const MAX_QUEUE = 10;
const MAX_NAME = 40;

/** Server-only, beside the room: the Clássico card, and Batata Quente's per-player throttle. */
interface Secrets extends Partial<ClassicSecrets> {
  lastTry?: Record<string, number>;
}

/** Firestore rejects `undefined`; a reveal or a prompt may carry optional fields. Plain data only. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

async function readRoom(tx: Transaction, id: string): Promise<Room> {
  const snap = await tx.get(roomRef(id));
  if (!snap.exists) throw mondoError("not-found", "No such room.");
  return snap.data() as Room;
}

async function readSecrets(tx: Transaction, id: string): Promise<Secrets> {
  const snap = await tx.get(roomSecretsRef(id));
  return (snap.data() as Secrets | undefined) ?? {};
}

const classicOf = (s: Secrets): ClassicSecrets => {
  if (!s.items || !s.plays) throw mondoError("not-found", "This game is not ready.");
  return { items: s.items, plays: s.plays };
};

/** The server's clock (invariant 3), as a Timestamp and as epoch ms. */
function clock(): { now: Timestamp; ms: number } {
  const now = Timestamp.now();
  return { now, ms: now.toMillis() };
}

/** A potato state that has ended ends the room with it. */
const withPotato = (room: Room, potato: PotatoState): Room =>
  potato.endedAt !== null ? { ...room, potato, state: "finished", finishedAt: potato.endedAt } : { ...room, potato };

function writePrompt(tx: Transaction, id: string, doc: PromptDoc): void {
  tx.set(roomSubRef(id, "prompts", String(doc.index)), plain(doc));
}

export const versus = callable<unknown, Record<string, unknown>>(async (uid, data, request) => {
  const body = requireObject(data);
  // The clock is read INSIDE each transaction, not once per call: Firestore
  // retries a contended transaction, and eight ticks racing one answer at a
  // deadline must each be judged at the moment they actually commit.
  const reply = (extra: Record<string, unknown> = {}) => ({ serverNow: Date.now(), ...extra });

  switch (body.op) {
    // ---------------------------------------------------------------- create
    case "create": {
      const preset = presetById(body.presetId);
      const id = inviteToken();
      await db().runTransaction(async (tx) => {
        const { now, ms } = clock();
        const profile = await ensureProfile(tx, uid, now);
        // FR-10.3, D-84: hosting is what invited players and subscribers have,
        // like making a group. Joining is open to anyone signed in.
        requireCanCreateGroup(rankOf(profile, signInProvider(request), now));
        tx.create(roomRef(id), newRoom(uid, profile.displayName, preset.mode, preset.id, ms));
      });
      return reply({ room: id });
    }

    // ------------------------------------------------------------------ join
    case "join": {
      const id = requireInviteToken(body.room);
      const mine = await db().runTransaction(async (tx) => {
        const { now, ms } = clock();
        const room = await readRoom(tx, id);
        const secrets = room.mode === "classic" && room.state !== "lobby" ? await readSecrets(tx, id) : null;
        const profile = await ensureProfile(tx, uid, now);
        const after = joinRoom(room, uid, profile.displayName, ms);
        if (after !== room) tx.set(roomRef(id), after);
        // Coming back to a running Clássico: the player's own guesses on the
        // challenge on screen, which nobody else's listener can give them.
        return secrets ? classicMine(room, classicOf(secrets), uid) : null;
      });
      return reply({ room: id, mine });
    }

    // ----------------------------------------------------------------- leave
    case "leave": {
      const id = requireInviteToken(body.room);
      await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        const after = leaveRoom(room, uid, ms);
        if (after !== room) tx.set(roomRef(id), after);
      });
      return reply();
    }

    // ----------------------------------------------------------------- start
    case "start": {
      const id = requireInviteToken(body.room);
      const peek = (await roomRef(id).get()).data() as Room | undefined;
      if (!peek) throw mondoError("not-found", "No such room.");
      // The host's checks before the week-ahead query, so no other player can spend it.
      requireStartable(peek, uid, Date.now());
      const preset = presetById(peek.presetId);
      // D-91: the week of daily answers ahead is withheld, as in practice (D-60).
      // Read outside the transaction: it is a query over `puzzles`, which no
      // Versus write touches, and the card is built once either way.
      const items = preset.spec ? buildCard(preset.spec, new Set(await dailyAhead(Timestamp.now()))) : null;
      await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        requireStartable(room, uid, ms);
        if (items) {
          const started = startClassic(room, items, ms);
          tx.set(roomRef(id), started.room);
          tx.set(roomSecretsRef(id), started.secrets);
          writePrompt(tx, id, started.prompt);
        } else {
          tx.set(roomRef(id), { ...room, state: "playing", startedAt: ms, potato: newPotato(room.playerUids, ms) });
          tx.set(roomSubRef(id, "map", "_base"), mapBase());
        }
      });
      return reply();
    }

    // ------------------------------------------------------------------ tick
    case "tick": {
      const id = requireInviteToken(body.room);
      const moved = await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        requirePlayer(room, uid);
        if (room.state !== "playing") return false;
        if (room.mode === "potato") {
          const p = room.potato!;
          if (ms < p.deadline) return false;
          tx.set(roomRef(id), withPotato(room, applyTimeout(p, ms)));
          return true;
        }
        const t = tickClassic(room, classicOf(await readSecrets(tx, id)), ms);
        if (!t) return false;
        tx.set(roomRef(id), t.room);
        tx.set(roomSecretsRef(id), t.secrets);
        if (t.reveal) tx.update(roomSubRef(id, "prompts", String(room.classic!.index)), { reveal: plain(t.reveal) });
        if (t.prompt) writePrompt(tx, id, t.prompt);
        return true;
      });
      return reply({ moved });
    }

    // ----------------------------------------------------------------- guess
    case "guess": {
      const id = requireInviteToken(body.room);
      const raw = body.guess;
      if (typeof raw !== "string" && typeof raw !== "number") throw mondoError("invalid-argument", "A guess must be a country or a number.");
      const selfReport = parseSelfReport(body.selfReport); // D-77: stored beside the guess, never scored
      const mine = await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        requirePlayer(room, uid);
        requirePlaying(room, "classic");
        const r = classicGuess(room, classicOf(await readSecrets(tx, id)), uid, raw, ms, selfReport);
        tx.set(roomRef(id), r.room);
        tx.set(roomSecretsRef(id), r.secrets);
        if (r.reveal) tx.update(roomSubRef(id, "prompts", String(room.classic!.index)), { reveal: plain(r.reveal) });
        return classicMine(room, r.secrets, uid);
      });
      return reply({ mine });
    }

    // ---------------------------------------------------------------- answer
    case "answer": {
      const id = requireInviteToken(body.room);
      const names = body.names;
      if (!Array.isArray(names) || names.length === 0 || names.length > MAX_QUEUE ||
          !names.every((n) => typeof n === "string" && n.length > 0 && n.length <= MAX_NAME)) {
        throw mondoError("invalid-argument", `Send 1 to ${MAX_QUEUE} names of at most ${MAX_NAME} characters.`);
      }
      const result = await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        requirePlayer(room, uid);
        requirePlaying(room, "potato");
        const p = room.potato!;
        checkTurn(p, uid, ms);
        // SEC-5's floor, per player and within a turn, kept off the room
        // document so a refused answer costs nobody else a read. A new turn
        // starts clean: a queue sent the instant it opens is the whole point.
        const secrets = await readSecrets(tx, id);
        const last = secrets.lastTry?.[uid];
        if (last !== undefined && last >= p.turnStartedAt && ms - last < GUESS_MIN_INTERVAL_MS) {
          throw mondoError("rate-limited", "Too fast. Try again.");
        }
        tx.set(roomSecretsRef(id), { lastTry: { [uid]: ms } }, { merge: true });

        // The queue is tried in order and the first name that is a country not
        // yet on the map is the answer. Everything before it is reported back,
        // so the client can drop what was already taken.
        const dropped: { name: string; reason: string }[] = [];
        for (const name of names as string[]) {
          const m = matchCountry(name);
          if ("error" in m) { dropped.push({ name, reason: m.error }); continue; }
          if (p.named.includes(m.code)) { dropped.push({ name, reason: "already-named" }); continue; }
          const { state, points } = applyAnswer(p, uid, m.code, ms);
          tx.set(roomRef(id), withPotato(room, state));
          tx.set(roomSubRef(id, "map", m.code), {
            code: m.code,
            name: countryByCode(m.code)!.names["pt-BR"],
            by: uid,
            color: room.players[uid]!.color,
            points,
            at: ms,
            ...mapPiece(m.code),
          });
          return { accepted: { name, code: m.code, points }, dropped };
        }
        return { accepted: null, dropped };
      });
      return reply(result);
    }

    // ---------------------------------------------------------------- giveUp
    case "giveUp": {
      const id = requireInviteToken(body.room);
      const mine = await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const room = await readRoom(tx, id);
        requirePlayer(room, uid);
        if (room.mode === "potato") {
          requirePlaying(room, "potato");
          tx.set(roomRef(id), withPotato(room, giveUpPotato(room.potato!, uid, ms)));
          return null;
        }
        requirePlaying(room, "classic");
        const r = classicGiveUp(room, classicOf(await readSecrets(tx, id)), uid, ms);
        tx.set(roomRef(id), r.room);
        tx.set(roomSecretsRef(id), r.secrets);
        if (r.reveal) tx.update(roomSubRef(id, "prompts", String(room.classic!.index)), { reveal: plain(r.reveal) });
        return classicMine(room, r.secrets, uid);
      });
      return reply({ mine });
    }

    default:
      throw mondoError("invalid-argument", "Unknown op.");
  }
});
