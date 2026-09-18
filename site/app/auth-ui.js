// Sign-in button, auth state and the account menu — the chrome every page but
// the game shares. game.js keeps its own auth listener because it also resets
// round state, but it uses the menu helpers below like everyone else.

import { onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth, googleProvider } from "./firebase.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

/**
 * Wires #sign-in / #sign-out and calls onUser(user|null) on every change.
 *
 * Given `adminLink` and `profile` it also asks who the viewer is, because the
 * chrome needs two things the Firebase session does not carry: the role, which
 * decides whether the Painel link is drawn, and the display name the GAME knows
 * them by, which is not the one on their Google account. game.js does not use
 * this — the daily already has both from getRound and calls applyIdentity with
 * what it was sent rather than asking twice.
 */
export function watchAuth({ signIn, signOut, signedOut, account, adminLink, profile, setStatus, onUser }) {
  signIn?.addEventListener("click", async () => {
    signIn.disabled = true;
    setStatus(t("openingLogin"));
    try { await signInWithPopup(auth, googleProvider); setStatus(""); }
    catch (err) { setStatus(errorMessage(err), "err"); }
    finally { signIn.disabled = false; }
  });
  signOut?.addEventListener("click", () => auth.signOut());
  attachAccount(account);
  onAuthStateChanged(auth, (user) => {
    if (signedOut) signedOut.hidden = Boolean(user);
    if (signOut) signOut.hidden = !user;
    showAccount(account, user);
    if (adminLink) adminLink.hidden = true;
    if (user && (adminLink || profile)) identify({ account, user, adminLink, profile });
    onUser(user);
  });
}

/**
 * Never on the critical path. A chrome that cannot load is a menu without a
 * Painel link and a Perfil box that opens empty — not a page that failed — so
 * nothing here reaches setStatus.
 */
function identify(chrome) {
  api.listGroups({})
    .then(({ me }) => applyIdentity(chrome, me))
    .catch(() => { /* the menu stands as it is */ });
}

/**
 * Who the viewer is, as far as the chrome is concerned: the initials on the
 * avatar, whether the Painel link is drawn, and the name the Perfil dialog
 * prefills.
 *
 * It decides what is DRAWN and nothing else. Every callable behind the Painel
 * asserts the role itself (SEC-8), so a client that lies about it here reaches
 * a page that tells it no.
 */
export function applyIdentity({ account, user, adminLink, profile }, me) {
  showAccount(account, user, me?.displayName);
  if (adminLink) adminLink.hidden = me?.role !== "admin";
  // Never the Google name: prefilling that and letting Salvar through would
  // quietly overwrite the display name the group knows them by.
  profile?.setName(me?.displayName ?? "");
}

/** A <dialog> with a method="dialog" form whose buttons carry value="ok"/"cancel". Resolves true on ok. */
export function ask(dialog, textEl, text) {
  if (textEl) textEl.textContent = text;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

/** Initials for the avatar: the first letters of the first two words. */
export function initials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The account menu is a <details>, because the platform already ships a
 * disclosure that opens with a keyboard and closes on Escape. The two things it
 * does not do are close when you click elsewhere and close when you pick
 * something, which is all of this.
 */
export function attachAccount(account) {
  if (!account) return;
  document.addEventListener("click", (ev) => {
    if (account.open && !account.contains(ev.target)) account.open = false;
  });
  account.addEventListener("click", (ev) => {
    if (ev.target.closest(".account-menu a, .account-menu button")) account.open = false;
  });
}

/** Show the menu once there is someone to show it to, wearing their initials. */
export function showAccount(account, user, displayName) {
  if (!account) return;
  account.hidden = !user;
  if (!user) return void (account.open = false);
  const summary = account.querySelector("summary");
  if (summary) summary.textContent = initials(displayName ?? user.displayName);
}
