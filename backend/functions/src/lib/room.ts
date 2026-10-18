/**
 * Multijogador rooms (FR-12.1): who is in, who hosts, and when it starts. Pure; times
 * are epoch milliseconds from the server clock.
 *
 * A room is reached by its link, and its link is its id: 16 characters of the
 * invite alphabet (D-32), so it cannot be guessed and nobody needs a group to
 * be in one. Anyone signed in may join, a guest included — that is the whole
 * point of Multijogador over tournaments (D-88). Only hosting is ranked: a room is
 * what invited players and subscribers can make, exactly like a group.
 *
 * The room document is readable by its players (D-87), so nothing here may
 * ever hold an answer. The Clássico card lives in `roomSecrets`, beside it.
 */

import type { KindId, Prompt, Reveal } from "./kinds";
import type { PotatoState } from "./potato";
import { mondoError } from "./errors";

export const ROOM_MAX_PLAYERS = 8;
const ROOM_MIN_PLAYERS = 2;
/** A lobby nobody started is gone after this long. */
export const LOBBY_TTL_MS = 2 * 3_600_000;

/** One colour per seat, distinct in both themes; the map is painted in them. */
export const PLAYER_COLORS = ["#e4572e", "#17a398", "#d4a017", "#5b8c2a", "#a05195", "#2e86ab", "#e07a9f", "#8d6e63"] as const;

export type RoomMode = "classic" | "potato";
export type RoomState = "lobby" | "playing" | "finished";

export interface RoomPlayer {
  name: string;
  color: string;
  joinedAt: number;
  /** Clássico points (Batata Quente keeps its own in `potato.scores`). */
  score: number;
  /** Clássico tiebreak: total time to solve. */
  timeMs: number;
}

/** What every player of a Clássico room sees of the challenge on screen. Never the subject. */
export interface ClassicPublic {
  kinds: KindId[];
  index: number;
  phase: "question" | "reveal";
  startedAt: number;
  deadline: number;
  durationMs: number;
  guessesMax: number;
  /** Per player, counts only: a rival's distances and arrows would be free hints. */
  progress: Record<string, { guesses: number; done: boolean; solved: boolean; points: number | null }>;
}

/** Stored at `rooms/{id}/prompts/{index}`: big (eight flags), so written once rather than on every guess. */
export interface PromptDoc {
  index: number;
  prompt: Prompt;
  /** Only once the challenge is over (SEC-1). */
  reveal: Reveal | null;
}

export interface Room {
  mode: RoomMode;
  presetId: string;
  hostUid: string;
  state: RoomState;
  players: Record<string, RoomPlayer>;
  /** Join order, and the field firestore.rules reads to let a player in. */
  playerUids: string[];
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  classic: ClassicPublic | null;
  potato: PotatoState | null;
}

export function newRoom(hostUid: string, hostName: string, mode: RoomMode, presetId: string, now: number): Room {
  return {
    mode,
    presetId,
    hostUid,
    state: "lobby",
    players: { [hostUid]: seat(hostName, 0, now) },
    playerUids: [hostUid],
    createdAt: now,
    expiresAt: now + LOBBY_TTL_MS,
    startedAt: null,
    finishedAt: null,
    classic: null,
    potato: null,
  };
}

const seat = (name: string, i: number, now: number): RoomPlayer => ({
  name, color: PLAYER_COLORS[i % PLAYER_COLORS.length]!, joinedAt: now, score: 0, timeMs: 0,
});

/** Joining twice is not an error: reopening the link is how a player comes back to the page. */
export function joinRoom(room: Room, uid: string, name: string, now: number): Room {
  if (room.playerUids.includes(uid)) return room;
  if (room.state !== "lobby") throw mondoError("room-started", "This game has already started.");
  if (now >= room.expiresAt) throw mondoError("not-found", "This room has expired.");
  if (room.playerUids.length >= ROOM_MAX_PLAYERS) throw mondoError("room-full", "This room is full.");
  const taken = new Set(Object.values(room.players).map((p) => p.color));
  const i = PLAYER_COLORS.findIndex((c) => !taken.has(c));
  return {
    ...room,
    players: { ...room.players, [uid]: seat(name, i, now) },
    playerUids: [...room.playerUids, uid],
  };
}

/**
 * Leave a lobby. The host's seat passes to whoever joined next; the last one out
 * closes the room. Once a game is running there is no leaving, only giving up —
 * the scoreboard would otherwise lose a row mid-game.
 */
export function leaveRoom(room: Room, uid: string, now: number): Room {
  if (!room.playerUids.includes(uid)) return room;
  if (room.state !== "lobby") throw mondoError("room-started", "The game has started; give up instead.");
  const playerUids = room.playerUids.filter((u) => u !== uid);
  const players = { ...room.players };
  delete players[uid];
  if (playerUids.length === 0) return { ...room, players, playerUids, state: "finished", finishedAt: now };
  const hostUid = room.hostUid === uid ? playerUids[0]! : room.hostUid;
  return { ...room, players, playerUids, hostUid };
}

/** The host's checks for starting. The mode's own state is the caller's to attach. */
export function requireStartable(room: Room, uid: string, now: number): void {
  if (room.hostUid !== uid) throw mondoError("permission-denied", "Only the host can start the game.");
  if (room.state !== "lobby") throw mondoError("room-started", "This game has already started.");
  if (now >= room.expiresAt) throw mondoError("not-found", "This room has expired.");
  if (room.playerUids.length < ROOM_MIN_PLAYERS) throw mondoError("invalid-argument", `A game needs at least ${ROOM_MIN_PLAYERS} players.`);
}

export function requirePlayer(room: Room, uid: string): void {
  if (!room.playerUids.includes(uid)) throw mondoError("permission-denied", "You are not in this room.");
}

export function requirePlaying(room: Room, mode: RoomMode): void {
  if (room.mode !== mode) throw mondoError("invalid-argument", "Wrong game for this room.");
  if (room.state === "finished") throw mondoError("already-completed", "This game is over.");
  if (room.state !== "playing") throw mondoError("invalid-argument", "This game has not started.");
}
