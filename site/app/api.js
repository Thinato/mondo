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
