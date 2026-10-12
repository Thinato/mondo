/**
 * Versus Clássico (FR-12.2): the challenge kinds, played live. Pure; times are
 * epoch milliseconds from the server clock.
 *
 * Everyone in the room gets the same challenge at the same moment, on one
 * countdown. Each player plays it exactly as they would the daily — the kind's
 * own guess budget, the 400 ms floor, the same 0–6 — through `lib/card.ts`,
 * unchanged: every player holds a `CardCore` of the room's card, and the room
 * only decides when an item opens and when it closes. A player who solves early
 * waits; a player still at it when the clock runs out is given up for, by the
 * same `giveUpCard` the daily's give-up button calls (D-61).
 *
 * Speed is worth something only on top of being right: a solve is multiplied
 * by up to 1.5 for the time left, and nothing times zero is zero.
 *
 * Presets, not settings (D-48's reasoning, kept): the host names one, the
 * server resolves it, and the client never supplies a kind or a count.
 */

import { Timestamp } from "firebase-admin/firestore";
import { applyCardGuess, giveUpCard, newCardCore, type CardCore, type CardItem, type CardSpec } from "./card";
import { mondoError } from "./errors";
import { KIND_IDS, kindById, type KindId, type Reveal } from "./kinds";
import type { SelfReport } from "./report";
import { guessView, type GuessView } from "./round";
import type { ClassicPublic, PromptDoc, Room, RoomMode } from "./room";

export interface VersusPreset {
  id: string;
  mode: RoomMode;
  /** Clássico only: the card every player in the room plays. */
  spec?: CardSpec;
}

export const VERSUS_PRESETS: readonly VersusPreset[] = [
  { id: "mundo", mode: "potato" },
  { id: "dia", mode: "classic", spec: { items: KIND_IDS.map((kind) => ({ kind, count: 1 })), order: "shuffled" } },
  { id: "bandeiras", mode: "classic", spec: { items: [{ kind: "flag", count: 3 }, { kind: "flagPick", count: 3 }], order: "shuffled" } },
  { id: "formas", mode: "classic", spec: { items: [{ kind: "shape", count: 3 }, { kind: "shapePick", count: 3 }], order: "shuffled" } },
  { id: "capitais", mode: "classic", spec: { items: [{ kind: "capital", count: 5 }], order: "as_listed" } },
  {
    id: "misto-10",
    mode: "classic",
    spec: {
      items: [
        { kind: "shape", count: 2 }, { kind: "flag", count: 2 }, { kind: "capital", count: 2 },
        { kind: "flagPick", count: 1 }, { kind: "shapePick", count: 1 }, { kind: "gdp", count: 1 }, { kind: "person", count: 1 },
      ],
      order: "shuffled",
    },
  },
];

export function presetById(id: unknown): VersusPreset {
  const p = VERSUS_PRESETS.find((x) => x.id === id);
  if (!p) throw mondoError("invalid-argument", "Unknown game preset.");
  return p;
}

/** A board of eight is read at a glance; a silhouette is not. */
export const secondsFor = (kind: KindId): number => (kind === "flagPick" || kind === "shapePick" ? 20 : 45);
/** How long the answer and the scoreboard stay up between challenges. */
export const REVEAL_MS = 5000;
const MAX_SPEED_BONUS = 0.5;

/** A solve's points, scaled up by the share of the clock left when it landed. Zero stays zero. */
export function speedPoints(itemPoints: number, solvedAt: number, startedAt: number, deadline: number): number {
  if (itemPoints <= 0) return 0;
  const left = Math.min(Math.max((deadline - solvedAt) / (deadline - startedAt), 0), 1);
  return Math.round(itemPoints * (1 + MAX_SPEED_BONUS * left));
}

/** Server-only, at `roomSecrets/{id}`: the subjects, and every player's play of them. */
export interface ClassicSecrets {
  items: CardItem[];
  plays: Record<string, CardCore>;
}

const ts = (ms: number) => Timestamp.fromMillis(ms);

function question(kinds: KindId[], index: number, items: readonly CardItem[], uids: readonly string[], now: number): ClassicPublic {
  const kind = kindById(items[index]!.kind);
  const durationMs = secondsFor(kind.id) * 1000;
  return {
    kinds,
    index,
    phase: "question",
    startedAt: now,
    deadline: now + durationMs,
    durationMs,
    guessesMax: kind.maxGuesses,
    progress: Object.fromEntries(uids.map((uid) => [uid, { guesses: 0, done: false, solved: false, points: null }])),
  };
}

const promptDoc = (items: readonly CardItem[], index: number): PromptDoc => ({
  index,
  prompt: kindById(items[index]!.kind).prompt(items[index]!),
  reveal: null,
});

export function startClassic(room: Room, items: CardItem[], now: number): { room: Room; secrets: ClassicSecrets; prompt: PromptDoc } {
  const uids = room.playerUids;
  const plays = Object.fromEntries(uids.map((uid) => [uid, newCardCore(uid, items, ts(now))]));
  return {
    room: { ...room, state: "playing", startedAt: now, classic: question(items.map((i) => i.kind), 0, items, uids, now) },
    secrets: { items, plays },
    prompt: promptDoc(items, 0),
  };
}

function openQuestion(room: Room, secrets: ClassicSecrets, uid: string, now: number): { c: ClassicPublic; play: CardCore } {
  const c = room.classic;
  if (!c) throw mondoError("invalid-argument", "This is not a Clássico room.");
  if (c.phase !== "question") throw mondoError("already-completed", "Wait for the next challenge.");
  if (now >= c.deadline) throw mondoError("time-up", "Time is up.");
  const play = secrets.plays[uid];
  if (!play) throw mondoError("permission-denied", "You are not in this game.");
  if (play.cursor !== c.index) throw mondoError("already-completed", "Wait for the next challenge.");
  return { c, play };
}

/** Record a player's new play and their public progress on the item on screen; close it if everyone is done. */
function settle(room: Room, secrets: ClassicSecrets, uid: string, play: CardCore, now: number) {
  const c = room.classic!;
  const it = play.items[c.index]!;
  const progress = { ...c.progress, [uid]: { guesses: it.guesses.length, done: it.finishedAt !== null, solved: it.solved, points: null } };
  const next = { room: { ...room, classic: { ...c, progress } }, secrets: { ...secrets, plays: { ...secrets.plays, [uid]: play } } };
  return Object.values(progress).every((p) => p.done) ? closeQuestion(next.room, next.secrets, now) : { ...next, reveal: null };
}

export function classicGuess(room: Room, secrets: ClassicSecrets, uid: string, raw: unknown, now: number, selfReport: SelfReport | null = null) {
  const { play } = openQuestion(room, secrets, uid, now);
  return settle(room, secrets, uid, applyCardGuess(play, secrets.items, raw, ts(now), selfReport), now);
}

export function classicGiveUp(room: Room, secrets: ClassicSecrets, uid: string, now: number) {
  const { play } = openQuestion(room, secrets, uid, now);
  return settle(room, secrets, uid, giveUpCard(play, secrets.items, ts(now)), now);
}

/**
 * The item on screen is over for everyone: give up for whoever is still at it,
 * score the room, and show the answer. Returns the reveal for the prompt doc.
 */
function closeQuestion(room: Room, secrets: ClassicSecrets, now: number): { room: Room; secrets: ClassicSecrets; reveal: Reveal } {
  const c = room.classic!;
  const plays = { ...secrets.plays };
  const players = { ...room.players };
  const progress = { ...c.progress };
  for (const uid of room.playerUids) {
    let play = plays[uid]!;
    if (play.cursor === c.index) play = giveUpCard(play, secrets.items, ts(now));
    plays[uid] = play;
    const it = play.items[c.index]!;
    const solvedAt = it.finishedAt!.toMillis();
    const points = it.solved ? speedPoints(it.points, solvedAt, c.startedAt, c.deadline) : 0;
    const p = players[uid]!;
    players[uid] = { ...p, score: p.score + points, timeMs: p.timeMs + (it.solved ? solvedAt - c.startedAt : 0) };
    progress[uid] = { guesses: it.guesses.length, done: true, solved: it.solved, points };
  }
  return {
    room: { ...room, players, classic: { ...c, phase: "reveal", progress, deadline: now + REVEAL_MS } },
    secrets: { ...secrets, plays },
    reveal: kindById(secrets.items[c.index]!.kind).reveal(secrets.items[c.index]!),
  };
}

/**
 * The clock ran out on whatever is on screen. Returns null when nothing is due
 * yet — the caller treats that as a no-op, since every client ticks.
 */
export function tickClassic(room: Room, secrets: ClassicSecrets, now: number):
  | { room: Room; secrets: ClassicSecrets; reveal: Reveal | null; prompt: PromptDoc | null }
  | null {
  const c = room.classic;
  if (!c || room.state !== "playing" || now < c.deadline) return null;
  if (c.phase === "question") return { ...closeQuestion(room, secrets, now), prompt: null };
  const index = c.index + 1;
  if (index >= secrets.items.length) {
    return { room: { ...room, state: "finished", finishedAt: now }, secrets, reveal: null, prompt: null };
  }
  return {
    room: { ...room, classic: question(c.kinds, index, secrets.items, room.playerUids, now) },
    secrets,
    reveal: null,
    prompt: promptDoc(secrets.items, index),
  };
}

/** A player's own view of the item on screen: their guesses, graded. Opponents never get this. */
export function classicMine(room: Room, secrets: ClassicSecrets, uid: string): { guesses: GuessView[]; done: boolean; solved: boolean } | null {
  const c = room.classic;
  const play = secrets.plays[uid];
  if (!c || !play) return null;
  const it = play.items[c.index]!;
  return { guesses: it.guesses.map(guessView), done: it.finishedAt !== null, solved: it.solved };
}

/** Most points first, then least time spent solving. */
export function classicRanking(room: Room): string[] {
  return [...room.playerUids].sort((a, b) => {
    const x = room.players[a]!;
    const y = room.players[b]!;
    return y.score - x.score || x.timeMs - y.timeMs;
  });
}
