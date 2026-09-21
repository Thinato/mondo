import { test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  INVITE_ALPHABET, INVITE_TOKEN_LENGTH, INVITE_TTL_MS, MULTI_INVITE_TTL_MS,
  inviteMode, inviteState, inviteToken, newInvite,
} from "../src/lib/invite";
import { requireInviteToken } from "../src/lib/validate";

const NOW = Timestamp.fromMillis(Date.parse("2026-09-15T15:00:00Z"));
const at = (ms: number) => Timestamp.fromMillis(NOW.toMillis() + ms);

test("FR-4.2: alphabet has 32 symbols and none of 0 1 I O", () => {
  assert.equal(INVITE_ALPHABET.length, 32);
  assert.equal(new Set(INVITE_ALPHABET).size, 32);
  for (const c of "01IO") assert.ok(!INVITE_ALPHABET.includes(c), c);
});

test("D-32: 16 chars from the alphabet only, across 10 000 draws", () => {
  const re = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_TOKEN_LENGTH}}$`);
  for (let i = 0; i < 10_000; i++) assert.match(inviteToken(), re);
});

test("inviteToken is deterministic under an injected picker", () => {
  assert.equal(inviteToken(() => 0), "A".repeat(16));
  assert.equal(inviteToken((n) => n - 1), "9".repeat(16));
});

test("newInvite: 7-day expiry, nothing used or revoked, group name denormalised", () => {
  const inv = newInvite("g".repeat(20), "Almoço", "owner1", NOW);
  assert.equal(inv.mode, "single");
  assert.equal(inv.uses, 0);
  assert.equal(inv.expiresAt.toMillis() - inv.createdAt.toMillis(), INVITE_TTL_MS);
  assert.equal(INVITE_TTL_MS, 7 * 86_400_000);
  assert.equal(inv.groupName, "Almoço");
  assert.equal(inv.usedBy, null);
  assert.equal(inv.revokedAt, null);
  assert.equal(inviteState(inv, NOW), "pending");
});

test("inviteState: pending until the last millisecond, then expired", () => {
  const inv = newInvite("g".repeat(20), "x", "u", NOW);
  assert.equal(inviteState(inv, at(INVITE_TTL_MS - 1)), "pending");
  assert.equal(inviteState(inv, at(INVITE_TTL_MS)), "expired");
});

test("inviteState: used beats revoked beats expired", () => {
  const inv = newInvite("g".repeat(20), "x", "u", NOW);
  const late = at(INVITE_TTL_MS + 1);
  assert.equal(inviteState({ ...inv, revokedAt: NOW }, late), "revoked");
  assert.equal(inviteState({ ...inv, revokedAt: NOW, usedBy: "v" }, late), "used");
  assert.equal(inviteState({ ...inv, usedBy: "v" }, NOW), "used");
});

test("requireInviteToken normalises case and rejects the wrong shape", () => {
  const tok = inviteToken(() => 5); // "F" × 16
  assert.equal(requireInviteToken(tok.toLowerCase()), tok);
  assert.equal(requireInviteToken(` ${tok} `), tok);
  for (const bad of ["", tok.slice(1), tok + "A", tok.slice(1) + "0", tok.slice(1) + "I", tok.slice(1) + "O", tok.slice(1) + "1", 42, null]) {
    assert.throws(() => requireInviteToken(bad), (e: unknown) => (e as { details: { code: string } }).details.code === "invalid-argument");
  }
});

test("FR-4.12: a multi-use invite lives 48 hours, a single-use one still lives 7 days", () => {
  const multi = newInvite("g".repeat(20), "Almoço", "owner1", NOW, "multi");
  assert.equal(multi.expiresAt.toMillis() - multi.createdAt.toMillis(), MULTI_INVITE_TTL_MS);
  assert.equal(MULTI_INVITE_TTL_MS, 2 * 86_400_000);
  assert.equal(multi.mode, "multi");
  assert.equal(newInvite("g".repeat(20), "Almoço", "owner1", NOW, "single").expiresAt.toMillis() - NOW.toMillis(), INVITE_TTL_MS);
  assert.ok(MULTI_INVITE_TTL_MS < INVITE_TTL_MS, "the link that admits everyone must die first");
});

test("FR-4.12: being accepted does not spend a multi-use invite", () => {
  // What acceptInvite writes for the multi branch: uses goes up, usedBy stays
  // null. If that ever flipped, the invite would vanish from the owner's list
  // (pendingInvitesOf filters usedBy == null) while still being live.
  const inv = { ...newInvite("g".repeat(20), "Almoço", "owner1", NOW, "multi"), uses: 7 };
  assert.equal(inv.usedBy, null);
  assert.equal(inviteState(inv, at(MULTI_INVITE_TTL_MS - 1)), "pending");
  assert.equal(inviteState(inv, at(MULTI_INVITE_TTL_MS)), "expired");
  assert.equal(inviteState({ ...inv, revokedAt: NOW }, NOW), "revoked");
});

test("D-71: an invite written before modes existed is the single-use kind", () => {
  assert.equal(inviteMode({}), "single");
  assert.equal(inviteMode({ mode: undefined }), "single");
  assert.equal(inviteMode({ mode: "multi" }), "multi");
});
