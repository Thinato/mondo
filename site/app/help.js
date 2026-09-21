// "?" — what the hints mean (FR-6.9, D-56).
//
// **Three topics, not six.** The six kinds share three hint vocabularies
// between them: shape, flag and capital all answer with a country, so they all
// give kilometres, a compass arrow and a proximity percentage; `gdp` answers
// with a number, so it gives higher/lower and a ratio; the two pick kinds
// answer with a pick and give no hint at all (D-64, D-72), which needs saying
// precisely because a player waiting for one would think the game was broken.
// Six popups to teach three vocabularies is three too many, and the pick text
// differs between flags and silhouettes by one noun — so it does not.
//
// **The first one opens itself.** The feedback that prompted this was "I didn't
// understand the percentage", from players who had the guess rows in front of
// them the whole session. A "?" nobody presses explains nothing, so the first
// time a player meets a topic the dialog is in the way and has to be closed.
// Once per topic, ever — remembered in localStorage, which is per-browser and
// carries nothing worth syncing.

import { isPick } from "./geo.js";
import { t } from "./i18n.js";

const key = (topic) => `mondo.help.${topic}`;
const topicOf = (kind) => (kind === "gdp" ? "gdp" : isPick(kind) ? "pick" : "country");

/**
 * Wire a page's help button and dialog. Returns the function to call on every
 * render with the kind currently on screen; it opens itself the first time.
 */
export function attachHelp({ button, dialog, title, body, close }) {
  let topic = "country";

  const open = () => {
    title.textContent = t("help.title");
    body.textContent = t(`help.${topic}`);
    if (!dialog.open) dialog.showModal();
  };

  button.addEventListener("click", open);
  close.addEventListener("click", () => dialog.close());
  // Also fires on Escape, which is the platform's contract and not worth
  // fighting: someone who dismisses it has seen it.
  dialog.addEventListener("close", () => remember(topic));

  return function help(kind) {
    if (kind === null || kind === undefined) return;
    topic = topicOf(kind);
    if (!seen(topic)) open();
  };
}

// localStorage throws outright in some privacy modes rather than returning
// null. The fallback is the harmless one: the dialog introduces itself again.
function seen(topic) {
  try { return localStorage.getItem(key(topic)) !== null; } catch { return false; }
}
function remember(topic) {
  try { localStorage.setItem(key(topic), "1"); } catch { /* nothing to do */ }
}
