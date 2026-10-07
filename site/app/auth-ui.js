// Sign-in button, auth state and the account menu — the chrome every page but
// the game shares. game.js keeps its own auth listener because it also resets
// round state, but it uses the menu helpers below like everyone else.

import {
  GoogleAuthProvider, linkWithPopup, onAuthStateChanged, signInAnonymously, signInWithCredential, signInWithPopup,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { auth, googleProvider } from "./firebase.js";
import * as api from "./api.js";
import { errorMessage, t } from "./i18n.js";

/**
 * Google sign-in. A guest is upgraded IN PLACE (FR-10.1): linking keeps the
 * uid, so the day they are halfway through is still theirs afterwards, and the
 * new ID token says google.com — which is all the server reads the rank from.
 *
 * If that Google account already plays here, linking is refused and we switch
 * to it instead; the guest's day stays with the guest.
 *
 * Either way the page reloads: nothing fires onAuthStateChanged on a link (the
 * user did not change), and a reload is the one way every page re-asks the
 * server who it is talking to — an invite link included, which is how a guest
 * who opened one gets into the group.
 */
export async function signInWithGoogle() {
  const user = auth.currentUser;
  if (!user?.isAnonymous) return void await signInWithPopup(auth, googleProvider);
  try {
    await linkWithPopup(user, googleProvider);
  } catch (err) {
    if (err?.code !== "auth/credential-already-in-use") throw err;
    const credential = GoogleAuthProvider.credentialFromError(err);
    if (!credential) throw err;
    // That account's day is its own, so whatever the guest played here stays
    // behind — say so rather than drop it silently. confirm() and not a
    // <dialog>: this runs on whichever page the button was on.
    if (!confirm(t("guestSwitch"))) return;
    await signInWithCredential(auth, credential);
  }
  location.reload();
}

/**
 * No session at all: become a guest straight away, so the game plays without a
 * sign-in wall (D-84). If the project refuses anonymous sign-in — the provider
 * not yet enabled — show the Google button instead, which is how every page
 * worked before guests existed.
 */
export function playAsGuest(signedOut) {
  signInAnonymously(auth).catch(() => { if (signedOut) signedOut.hidden = false; });
}

/**
 * The account menu's last item: Sair for an account, Entrar com Google for a
 * guest. Signing a guest out would only orphan their day and make another.
 */
export function wireAccountButton(button, setStatus) {
  button?.addEventListener("click", () => (auth.currentUser?.isAnonymous ? googleClick(button, setStatus) : auth.signOut()));
}

export async function googleClick(button, setStatus) {
  button.disabled = true;
  setStatus(t("openingLogin"));
  try { await signInWithGoogle(); setStatus(""); }
  catch (err) { setStatus(errorMessage(err), "err"); }
  finally { button.disabled = false; }
}

/** Sair for an account, Entrar com Google for a guest — see wireAccountButton. */
export function labelAccountButton(button, user) {
  if (button) button.textContent = user?.isAnonymous ? t("signIn") : t("signOut");
}

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
  signIn?.addEventListener("click", () => googleClick(signIn, setStatus));
  wireAccountButton(signOut, setStatus);
  attachAccount(account);
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      profile?.setName(""); // FR-1.6: the next person on this browser must not inherit a name
      playAsGuest(signedOut);
    } else if (signedOut) signedOut.hidden = true;
    labelAccountButton(signOut, user);
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
