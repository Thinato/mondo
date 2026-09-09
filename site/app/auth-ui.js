// Sign-in button + auth state, shared by the pages that are not the game
// (grupos, admin). game.js keeps its own copy because it also resets round state.

import { onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth, googleProvider } from "./firebase.js";
import { errorMessage, t } from "./i18n.js";

/** Wires #sign-in / #sign-out and calls onUser(user|null) on every change. */
export function watchAuth({ signIn, signOut, signedOut, setStatus, onUser }) {
  signIn?.addEventListener("click", async () => {
    signIn.disabled = true;
    setStatus(t("openingLogin"));
    try { await signInWithPopup(auth, googleProvider); setStatus(""); }
    catch (err) { setStatus(errorMessage(err), "err"); }
    finally { signIn.disabled = false; }
  });
  signOut?.addEventListener("click", () => auth.signOut());
  onAuthStateChanged(auth, (user) => {
    if (signedOut) signedOut.hidden = Boolean(user);
    if (signOut) signOut.hidden = !user;
    onUser(user);
  });
}

/** A <dialog> with a method="dialog" form whose buttons carry value="ok"/"cancel". Resolves true on ok. */
export function ask(dialog, textEl, text) {
  if (textEl) textEl.textContent = text;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}
