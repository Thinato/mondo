/**
 * Multijogador Clássico (FR-12.2): the challenge kinds, played live. Pure; times are
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
 * Presets, or a custom game (D-106): the host names a built-in preset, which
 * the server resolves, or sends kinds, order and continents for the server to
 * deal from. Never a country — the subjects are always the server's pick.
 */

import { Timestamp } from "firebase-admin/firestore";
import { applyCardGuess, boardOptions, buildCard, giveUpCard, newCardCore, type CardCore, type CardItem, type CardSpec } from "./card";
import { mondoError } from "./errors";
import { COUNTRIES, REGIONS, type Region } from "./countries";
import { KIND_IDS, kindById, type KindId, type Reveal } from "./kinds";
import type { SelfReport } from "./report";
import { revealOf } from "./hints";
import { guessView, type GuessView } from "./round";
import { finishRoom, CUSTOM_PRESET, type ClassicPublic, type CustomGame, type PromptDoc, type Room, type RoomMode } from "./room";

export interface MultiplayerPreset {
  id: string;
  mode: RoomMode;
  /** Training (D-93): one player, no clock, open to anyone signed in, and started on create. */
  solo?: boolean;
  /** Clássico only: the card every player in the room plays. */
  spec?: CardSpec;
}

export const MULTIPLAYER_PRESETS: readonly MultiplayerPreset[] = [
  { id: "mundo", mode: "potato" },
  { id: "treino", mode: "potato", solo: true },
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

export function presetById(id: unknown): MultiplayerPreset {
  const p = MULTIPLAYER_PRESETS.find((x) => x.id === id);
  if (!p) throw mondoError("invalid-argument", "Unknown game preset.");
  return p;
}

/**
 * D-106 — what a room deals from: its card spec, and the countries no part of
 * that card may show. A custom game's continents are D-70's exclusion, the same
 * mechanism as practice's filter, so subjects AND the pick kinds' distractors
 * stay inside them.
 */
export function specOf(room: Pick<Room, "presetId" | "custom">): { spec: CardSpec; outside: string[] } {
  const c = room.presetId === CUSTOM_PRESET ? room.custom : null;
  if (!c) {
    const spec = presetById(room.presetId).spec;
    if (!spec) throw mondoError("invalid-argument", "This preset has no card.");
    return { spec, outside: [] };
  }
  return {
    spec: { items: c.kinds.map((kind) => ({ kind, count: 1 })), order: c.shuffled ? "shuffled" : "as_listed" },
    outside: outsideRegions(c.regions),
  };
}

/**
 * Deal a room's card. `hidden` is what no player may be shown at all — D-91's
 * week of daily answers — and `outside` is the continents the host left out.
 *
 * Both go to `buildCard` as one exclusion, which keeps subjects AND boards
 * inside the continents (D-70). But a board needs seven distractors, and on a
 * small continent the card's own subjects and the week ahead can leave fewer:
 * `pickOptions` then falls back to its whole pool, answers included. So any
 * board that shows another challenge's subject or a coming daily is dealt
 * again from the WORLD minus exactly those — wider than the continents asked
 * for, never an answer (FR-8.7). Wider is the price of a fourteen-country
 * continent; a leak is not a price.
 *
 * A subject pool that runs dry is the host's own filter talking, so it is
 * `no-countries-left`, after a few tries: subjects are drawn by weight, and
 * whether a tight continent runs out depends on the draw.
 */
export function dealCard(spec: CardSpec, hidden: readonly string[], outside: readonly string[], rand: () => number = Math.random): CardItem[] {
  const exclude = new Set([...hidden, ...outside]);
  for (let attempt = 1; ; attempt++) {
    let items: CardItem[];
    try {
      items = buildCard(spec, exclude, rand);
    } catch (err) {
      if ((err as { details?: { code?: string } }).details?.code !== "not-found") throw err;
      if (attempt < DEAL_TRIES) continue;
      throw mondoError("no-countries-left", "Not enough countries in those continents for this game.");
    }
    const banned = new Set([...hidden, ...items.map((i) => i.subject)]);
    const leaks = (item: CardItem) => item.options?.some((c) => c !== item.subject && banned.has(c)) ?? false;
    return items.map((item) => {
      if (!leaks(item)) return item;
      const wider = { ...item, options: boardOptions(kindById(item.kind), item.subject, banned, rand)! };
      if (leaks(wider)) throw mondoError("no-countries-left", "Not enough countries for this board.");
      return wider;
    });
  }
}
const DEAL_TRIES = 5;

/** Every country not in the chosen continents. */
export function outsideRegions(regions: readonly Region[]): string[] {
  if (REGIONS.every((r) => regions.includes(r))) return [];
  const wanted = new Set<string>(regions);
  return [...COUNTRIES.values()].filter((c) => !wanted.has(c.region)).map((c) => c.code);
}

/** FR-12.11 — a host's saved custom game, on their own `users/{uid}` (owner-only, D-34). */
export type SavedPreset = CustomGame & { name: string };
export const SAVED_PRESETS_MAX = 10;

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("pt-BR") === b.trim().toLocaleLowerCase("pt-BR");

/** Saving under a name already there overwrites it, in place; an eleventh name is refused. */
export function savedUpsert(list: readonly SavedPreset[], preset: SavedPreset): SavedPreset[] {
  const i = list.findIndex((p) => sameName(p.name, preset.name));
  if (i >= 0) return list.map((p, j) => (j === i ? preset : p));
  if (list.length >= SAVED_PRESETS_MAX) throw mondoError("invalid-argument", `At most ${SAVED_PRESETS_MAX} saved presets.`);
  return [...list, preset];
}

export const savedRemove = (list: readonly SavedPreset[], name: string): SavedPreset[] => list.filter((p) => !sameName(p.name, name));

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
  /** D-91's week of daily answers, kept so a hint never names one (FR-14). Absent on rooms started before it. */
  ahead?: string[];
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

export function startClassic(room: Room, items: CardItem[], now: number, ahead: readonly string[] = []): { room: Room; secrets: ClassicSecrets; prompt: PromptDoc } {
  const uids = room.playerUids;
  const plays = Object.fromEntries(uids.map((uid) => [uid, newCardCore(uid, items, ts(now))]));
  return {
    room: { ...room, state: "playing", startedAt: now, classic: question(items.map((i) => i.kind), 0, items, uids, now) },
    secrets: { items, plays, ahead: [...ahead] },
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
    // FR-14: the items after this one are still to be asked, and the daily's
    // week ahead is withheld here as in practice — a hint naming either waits.
    // This reveal is stored where anyone with the link can read it.
    reveal: revealOf(secrets.items[c.index]!, new Set([...secrets.items.slice(c.index + 1).map((i) => i.subject), ...(secrets.ahead ?? [])])),
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
    return { room: finishRoom(room, now), secrets, reveal: null, prompt: null };
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
