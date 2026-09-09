// Thin wrapper over the callables (02-architecture.md §4). Nothing here knows
// the answer; it only relays what the server chose to send (SEC-1).

import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";
import { functions } from "./firebase.js";

const call = (name) => {
  const fn = httpsCallable(functions, name);
  return async (data) => (await fn(data)).data;
};

export const getRound = call("getRound");
export const submitGuess = call("submitGuess");
export const updateProfile = call("updateProfile");

// Phase 2 — groups, invites, boards (FR-4), admin (FR-7.2), account (FR-1.5).
export const createGroup = call("createGroup");
export const createInvite = call("createInvite");
export const listInvites = call("listInvites");
export const revokeInvite = call("revokeInvite");
export const acceptInvite = call("acceptInvite");
export const leaveGroup = call("leaveGroup");
export const removeMember = call("removeMember");
export const renameGroup = call("renameGroup");
export const listGroups = call("listGroups");
export const getLeaderboard = call("getLeaderboard");
export const listUsers = call("listUsers");
export const setRole = call("setRole");
export const listAllGroups = call("listAllGroups");
export const listAttempts = call("listAttempts");
export const grantRetry = call("grantRetry");
export const deleteAccount = call("deleteAccount");
