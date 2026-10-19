/**
 * Multijogador — FR-12. Live rooms, played by everyone at once (D-87, D-88).
 *
 * ONE callable, `multiplayer({ op, … })`, rather than one per action (D-92). Every
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
 * Nothing here reaches `attempts`: a Multijogador result lives on its room and on no
 * board (FR-12.1, the reason D-40 exists).
 */

import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { dailyAhead, db, ensureProfile, roomRef, roomSecretsRef, roomSubRef, userRef } from "./db";
import { requireCanCreateGroup, rankOf } from "./lib/authz";
import { countryByCode } from "./lib/countries";
import { mondoError } from "./lib/errors";
import { inviteToken } from "./lib/invite";
import { matchCountry } from "./lib/match";
import { applyAnswer, applyTimeout, checkTurn, giveUpPotato, newPotato, type PotatoState } from "./lib/potato";
import { parseSelfReport } from "./lib/report";
import {
  configureRoom, finishRoom, joinRoom, leaveRoom, newRoom, removePlayer, requirePlayer, requirePlaying, requireStartable, resetForGame,
  reusableHostRoom,
  type PromptDoc, type Room,
} from "./lib/room";
import { callable, signInProvider } from "./lib/callable";
import { GUESS_MIN_INTERVAL_MS } from "./lib/config";
import { requireCustomGame, requireInviteToken, requireObject, requirePresetName, requireUid } from "./lib/validate";
import {
  classicGiveUp, classicGuess, classicMine, dealCard, presetById, savedRemove, savedUpsert, specOf, startClassic, tickClassic, type ClassicSecrets,
} from "./lib/multiplayer";
import { mapBase, mapPiece } from "./lib/world";

/** At most this many names in one `answer`: training's backlog (FR-12.5). */
const MAX_QUEUE = 10;
/**
 * A timed game queues ONE name (D-95): what is sent when the turn comes round is
 * that name and whatever is in the box. More would let a client hedge against
 * a rival naming its pick first, which the one-slot queue is there to prevent.
 */
const MAX_TURN_NAMES = 2;
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

/** A potato state that has ended ends the game with it, and the room is a lobby again (D-104). */
const withPotato = (room: Room, potato: PotatoState): Room =>
  potato.endedAt !== null ? finishRoom({ ...room, potato }, potato.endedAt) : { ...room, potato };

/** A new room starts on Batata Quente; the host changes it in the lobby (FR-12.7). */
const DEFAULT_PRESET = "mundo";

const sameGame = (a: Room, b: Room) => a.presetId === b.presetId && JSON.stringify(a.custom ?? null) === JSON.stringify(b.custom ?? null);

function writePrompt(tx: Transaction, id: string, doc: PromptDoc): void {
  tx.set(roomSubRef(id, "prompts", String(doc.index)), plain(doc));
}

export const multiplayer = callable<unknown, Record<string, unknown>>(async (uid, data, request) => {
  const body = requireObject(data);
  // The clock is read INSIDE each transaction, not once per call: Firestore
  // retries a contended transaction, and eight ticks racing one answer at a
  // deadline must each be judged at the moment they actually commit.
  const reply = (extra: Record<string, unknown> = {}) => ({ serverNow: Date.now(), ...extra });

  switch (body.op) {
    // ---------------------------------------------------------------- create
    case "create": {
      const named = body.presetId !== undefined;
      const preset = presetById(named ? body.presetId : DEFAULT_PRESET);
      const fresh = inviteToken();
      const id = await db().runTransaction(async (tx) => {
        const { now, ms } = clock();
        const profile = await ensureProfile(tx, uid, now);
        const room = newRoom(uid, profile.displayName, preset.mode, preset.id, ms);
        if (preset.solo) {
          // D-93: training is practice, open to anyone signed in like FR-9, and
          // there is nobody to wait for — it starts now, with no clock. One open
          // training room per account: asking again goes back to it, so a guest
          // cannot pile up rooms (and their 36 KB of land) by clicking.
          const prev = profile.trainingRoom ? (await tx.get(roomRef(profile.trainingRoom))).data() as Room | undefined : undefined;
          if (prev?.state === "playing") return profile.trainingRoom!;
          tx.create(roomRef(fresh), { ...room, state: "playing", startedAt: ms, potato: newPotato([uid], ms, false) });
          tx.set(roomSubRef(fresh, "map", "_base"), mapBase());
          tx.set(userRef(uid), { trainingRoom: fresh }, { merge: true });
          return fresh;
        }
        // FR-10.3, D-84: hosting is what invited players and subscribers have,
        // like making a group. Joining is open to anyone signed in.
        requireCanCreateGroup(rankOf(profile, signInProvider(request), now));
        // D-103: a host has one standing room, and opening Multijogador goes
        // back to it — mid-game, or between games until it expires. So the
        // link a group already has keeps working, and clicking makes no rooms.
        const prev = profile.hostRoom ? (await tx.get(roomRef(profile.hostRoom))).data() as Room | undefined : undefined;
        if (prev && reusableHostRoom(prev, uid, ms)) {
          // A client from before the lobby picker names a preset here: honour
          // it between games, exactly as `configure` would.
          if (named && prev.state !== "playing" && prev.presetId !== preset.id) {
            tx.set(roomRef(profile.hostRoom!), configureRoom(prev, uid, preset, ms));
          }
          return profile.hostRoom!;
        }
        tx.create(roomRef(fresh), room);
        tx.set(userRef(uid), { hostRoom: fresh }, { merge: true });
        return fresh;
      });
      return reply({ room: id });
    }

    // ------------------------------------------------------------------ join
    case "join": {
      const id = requireInviteToken(body.room);
      const mine = await db().runTransaction(async (tx) => {
        const { now, ms } = clock();
        const room = await readRoom(tx, id);
        // Between games there is nothing on screen to come back to (D-104), and
        // a room set to Clássico after a Batata Quente has no card at all.
        const secrets = room.mode === "classic" && room.state === "playing" ? await readSecrets(tx, id) : null;
        const profile = await ensureProfile(tx, uid, now);
        const after = joinRoom(room, uid, profile.displayName, ms);
        if (after !== room) tx.set(roomRef(id), after);
        // Coming back to a running Clássico: the player's own guesses on the
        // challenge on screen, which nobody else's listener can give them.
        // FR-12.11: and the caller's OWN saved games — never anyone else's.
        return { mine: secrets ? classicMine(room, classicOf(secrets), uid) : null, presets: profile.presets ?? [] };
      });
      return reply({ room: id, ...mine });
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

    // ------------------------------------------------------------- configure
    case "configure": {
      const id = requireInviteToken(body.room);
      // A built-in preset by id, or (FR-12.10, D-106) a custom game by value.
      const game = body.custom !== undefined ? requireCustomGame(body.custom) : presetById(body.presetId);
      if ("kinds" in game) {
        // Refuse a game the pool cannot fill now, not when everyone is waiting
        // on Start. The host's checks first, so nobody else spends the query.
        const peek = (await roomRef(id).get()).data() as Room | undefined;
        if (!peek) throw mondoError("not-found", "No such room.");
        const { spec, outside } = specOf(configureRoom(peek, uid, game, Date.now()));
        dealCard(spec, await dailyAhead(Timestamp.now()), outside);
      }
      await db().runTransaction(async (tx) => {
        const { ms } = clock();
        tx.set(roomRef(id), configureRoom(await readRoom(tx, id), uid, game, ms));
      });
      return reply();
    }

    // ----------------------------------------------------- savePreset / deletePreset
    case "savePreset": {
      // FR-12.11: a host's own custom games, on their own profile. Saving is
      // hosting's rank, like the room it is for; deleting is always yours.
      const preset = requireCustomGame(body.preset);
      const name = requirePresetName((body.preset as { name?: unknown }).name);
      const presets = await db().runTransaction(async (tx) => {
        const { now } = clock();
        const profile = await ensureProfile(tx, uid, now);
        requireCanCreateGroup(rankOf(profile, signInProvider(request), now));
        const list = savedUpsert(profile.presets ?? [], { ...preset, name });
        tx.set(userRef(uid), { presets: list }, { merge: true });
        return list;
      });
      return reply({ presets });
    }

    case "deletePreset": {
      const name = requirePresetName(body.name);
      const presets = await db().runTransaction(async (tx) => {
        const { now } = clock();
        const profile = await ensureProfile(tx, uid, now);
        const list = savedRemove(profile.presets ?? [], name);
        if (list.length !== (profile.presets ?? []).length) tx.set(userRef(uid), { presets: list }, { merge: true });
        return list;
      });
      return reply({ presets });
    }

    // ---------------------------------------------------------------- remove
    case "remove": {
      const id = requireInviteToken(body.room);
      const target = requireUid(body.uid);
      await db().runTransaction(async (tx) => {
        const room = await readRoom(tx, id);
        const after = removePlayer(room, uid, target);
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
      const dealt = peek.mode === "classic" ? specOf(peek) : null;
      // D-91: the week of daily answers ahead is withheld, as in practice (D-60).
      // Read outside the transaction: it is a query over `puzzles`, which no
      // Multijogador write touches, and the card is built once either way.
      const ahead = dealt ? await dailyAhead(Timestamp.now()) : [];
      // D-106: a custom game's continents ride on the same exclusion (D-70).
      const items = dealt ? dealCard(dealt.spec, ahead, dealt.outside) : null;
      await db().runTransaction(async (tx) => {
        const { ms } = clock();
        const before = await readRoom(tx, id);
        requireStartable(before, uid, ms);
        // The card above was built for the preset read then; a host who changed
        // it in between gets asked to press again rather than the wrong game.
        if (!sameGame(before, peek)) throw mondoError("invalid-argument", "The game changed. Try again.");
        // D-104: a rematch. The last game's prompts and countries go in the same
        // transaction that starts the next one — a stale reveal at prompts/3
        // would otherwise sit under the new game's third challenge. At most 196
        // countries and a card's prompts: well under a transaction's 500 writes.
        if (before.state === "finished") {
          // Ids only: a map document carries a country's whole outline.
          const [oldPrompts, oldMap] = await Promise.all([
            tx.get(roomRef(id).collection("prompts").select()), tx.get(roomRef(id).collection("map").select()),
          ]);
          // Not the one document the new game writes over anyway: one write per document.
          const keep = items ? "0" : "_base";
          for (const d of [...oldPrompts.docs, ...oldMap.docs]) if (d.id !== keep) tx.delete(d.ref);
          if (!items) tx.delete(roomSecretsRef(id)); // the last Clássico's card has no business outliving it
        }
        const room = resetForGame(before);
        if (items) {
          const started = startClassic(room, items, ms, ahead);
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
          if (p.deadline === null || ms < p.deadline) return false;
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
        // Training (D-93) has no turn to pass: every acceptable name is taken,
        // and there is no floor, because there is no secret to brute-force and
        // a floor between one player's own turns only refuses a fast typist.
        const solo = p.limitMs === null;
        if (!solo && names.length > MAX_TURN_NAMES) {
          throw mondoError("invalid-argument", `Send at most ${MAX_TURN_NAMES} names on a turn.`);
        }
        if (!solo) {
          // SEC-5's floor, per player and within a turn, kept off the room
          // document so a refused answer costs nobody else a read. A new turn
          // starts clean: a queue sent the instant it opens is the whole point.
          const secrets = await readSecrets(tx, id);
          const last = secrets.lastTry?.[uid];
          if (last !== undefined && last >= p.turnStartedAt && ms - last < GUESS_MIN_INTERVAL_MS) {
            throw mondoError("rate-limited", "Too fast. Try again.");
          }
          tx.set(roomSecretsRef(id), { lastTry: { [uid]: ms } }, { merge: true });
        }

        // The queue is tried in order and the first name that is a country not
        // yet on the map is the answer — every such name, in training. What was
        // refused before it is reported back, so the client can drop it.
        const accepted: { name: string; code: string; points: number }[] = [];
        const dropped: { name: string; reason: string }[] = [];
        let state = p;
        for (const name of names as string[]) {
          const m = matchCountry(name);
          if ("error" in m) { dropped.push({ name, reason: m.error }); continue; }
          if (state.named.includes(m.code)) { dropped.push({ name, reason: "already-named" }); continue; }
          const r = applyAnswer(state, uid, m.code, ms);
          state = r.state;
          accepted.push({ name, code: m.code, points: r.points });
          tx.set(roomSubRef(id, "map", m.code), {
            code: m.code,
            name: countryByCode(m.code)!.names["pt-BR"],
            by: uid,
            color: room.players[uid]!.color,
            points: r.points,
            at: ms,
            ...mapPiece(m.code),
          });
          if (!solo || state.endedAt !== null) break;
        }
        if (accepted.length > 0) tx.set(roomRef(id), withPotato(room, state));
        return { accepted, dropped };
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
