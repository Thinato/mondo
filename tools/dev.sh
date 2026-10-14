#!/usr/bin/env bash
#
# Everything needed to play the local game, in one command:
#
#   tools/dev.sh                     every account is promoted to admin
#   MONDO_DEV_GRANT=0 tools/dev.sh   ranks stay as they are (FR-12.4)
#
# Builds the functions, starts the emulators, seeds a week of puzzles, serves
# `site/`, and opens the browser. Ctrl-C stops all of it.
#
# The one thing it does that the real app never would: every account that signs
# in with Google is granted `admin`, in a loop — its profile made if it has none
# — so a fresh emulator account can make groups and host Versus rooms straight
# away (FR-10.3). The emulator is its own empty database: a production role
# means nothing here, and a browser that has not signed in is a guest. It is scoped to the `demo-mondo`
# emulator and refuses to run against anything else. Turn it off with
# MONDO_DEV_GRANT=0 to test the rank gate itself — then grant ranks by hand:
#
#   node tools/set-role.mjs --emulator --uid <uid> --role invited
#
# Several players on one machine (Versus): every browser keeps its own session,
# and so does every ORIGIN — http://localhost:8000 and http://127.0.0.1:8000 are
# two players in one Chrome, an incognito window is a third, Firefox a fourth.
# A window that never signs in with Google plays as a guest.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$(mktemp -t mondo-emulators)"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"   # the Firestore emulator needs a JRE

EMU_PID=""; WEB_PID=""; GRANT_PID=""; STOPPING=""
GRANT="${MONDO_DEV_GRANT:-1}"

cleanup() {
  # INT (or TERM) fires the handler and then EXIT fires it again. Everything in
  # here is idempotent, but running the ten-second wait twice and printing
  # "stopping" twice reads like something went wrong.
  [ -n "$STOPPING" ] && return 0
  STOPPING=1
  echo ""
  echo "stopping…"
  # The emulator parent first, and politely: firebase-tools takes its own Java
  # child down on SIGTERM, but only if it is given a moment. A stale Firestore
  # emulator holding port 8080 is an afternoon of confusion the next time
  # someone runs the e2e suite, and it has already cost one.
  [ -n "$EMU_PID" ] && kill "$EMU_PID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "cloud-firestore-emulator" >/dev/null 2>&1 || break
    sleep 1
  done
  # Whatever outlived that, by name. Not `kill 0`: this script is usually not
  # its own process group leader, so that signals the caller's group — which
  # is at best ineffective and at worst kills the terminal it was run from.
  pkill -f "cloud-firestore-emulator" 2>/dev/null || true
  pkill -f "emulators:start --project demo-mondo" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null
  [ -n "$GRANT_PID" ] && kill "$GRANT_PID" 2>/dev/null
  # By name as well as by PID. This loop promotes every profile it can see to
  # admin, so an orphan of it is not untidy, it is dangerous: it reattaches to
  # whatever comes up on 8080 next and quietly rewrites that data. It outlived
  # its PID once — the subshell was signalled rather than node — and the next
  # e2e run failed fourteen tests because every account in it had become admin.
  pkill -f "mondo-dev-grant" 2>/dev/null || true
  return 0
}
trap cleanup EXIT INT TERM

echo "==> building functions"
npm --prefix backend/functions run build

echo "==> starting emulators (log: $LOG)"
(cd backend && exec npx --yes firebase-tools@latest emulators:start \
  --project demo-mondo --only auth,firestore,functions >"$LOG" 2>&1) &
EMU_PID=$!

until grep -q "All emulators ready" "$LOG" 2>/dev/null; do
  sleep 1
  # If the emulators died, say why rather than looping until someone gives up.
  grep -qiE "error|address already in use" "$LOG" && { tail -20 "$LOG"; exit 1; }
done
echo "==> emulators up"

echo "==> seeding a week of puzzles"
(cd backend/functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-mondo node -e '
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "demo-mondo" });
const { puzzleIdAt, opensAt } = require("./lib/lib/puzzle-day");
const { buildCard } = require("./lib/lib/card");
const { KIND_IDS } = require("./lib/lib/kinds");
const db = admin.firestore();
(async () => {
  // A day is one challenge of every shipped kind (FR-2.1a, D-66), which is five
  // since flagPick joined. Built through buildCard rather than listed, so this
  // cannot drift from what the server considers a day.
  const spec = { items: KIND_IDS.map((kind) => ({ kind, count: 1 })), order: "shuffled" };
  const used = new Set();
  for (let d = 0; d < 7; d++) {
    const id = puzzleIdAt(new Date(Date.now() + d * 86400000));
    const items = buildCard(spec, used);
    items.forEach((i) => used.add(i.subject));
    await db.doc(`puzzles/${id}`).set({ puzzleId: id, items,
      opensAt: admin.firestore.Timestamp.fromDate(opensAt(id)) });
  }
  console.log("    7 days seeded from " + puzzleIdAt(new Date()));
})();
' 2>/dev/null)

echo "==> serving site/ on :8000"
# /grupos serves grupos.html, as GitHub Pages does in production.
(cd site && exec python3 -c '
import http.server, os
class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        file = super().translate_path(path)
        return file + ".html" if not os.path.exists(file) and os.path.exists(file + ".html") else file
http.server.ThreadingHTTPServer(("", 8000), Handler).serve_forever()
' >/dev/null 2>&1) &
WEB_PID=$!

# Grant admin to whoever signs in with Google. Polled rather than triggered:
# there is nothing to hook. An account that has no profile yet — it went
# straight to sala.html, which never creates one — gets one made here, so
# "sign in with Google" is all it takes on any page. Guests are left alone:
# a guest's rank is read off the token (FR-10.1), so a role would do nothing.
if [ "$GRANT" != "0" ]; then
(cd backend/functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 GCLOUD_PROJECT=demo-mondo exec node -e '
// mondo-dev-grant — the marker cleanup greps for. Do not remove: an orphan of
// this loop grants admin to every profile in whatever is on port 8080.
const admin = require("firebase-admin");
const { newProfile } = require("./lib/lib/round");
admin.initializeApp({ projectId: "demo-mondo" });
const db = admin.firestore();
setInterval(async () => {
  const users = await admin.auth().listUsers().catch(() => null);
  for (const u of users?.users ?? []) {
    if (u.providerData.length === 0) continue; // a guest
    const ref = db.doc(`users/${u.uid}`);
    const snap = await ref.get().catch(() => null);
    if (!snap || (snap.exists && snap.data().role === "admin")) continue;
    if (snap.exists) await ref.update({ role: "admin" });
    else await ref.set({ ...newProfile(admin.firestore.Timestamp.now()), role: "admin" });
    console.log("    granted admin to " + (u.email ?? u.uid));
  }
}, 2000);
' 2>/dev/null) &
GRANT_PID=$!
else
  echo "==> MONDO_DEV_GRANT=0: ranks are left alone"
fi

sleep 1
echo ""
echo "  treino (the pick kinds live here):  http://localhost:8000/praticar"
echo "  o jogo do dia:                 http://localhost:8000/"
echo "  versus, player 1:              http://localhost:8000/sala"
echo "  versus, player 2 (same Chrome): http://127.0.0.1:8000/sala"
echo "  emulator UI:                   http://127.0.0.1:4000/"
echo ""
echo "  Sign in with Google → 'Add new account' → any email. Ctrl-C to stop."
echo "  More players: an incognito window, another browser — each is its own account."
open http://localhost:8000/praticar 2>/dev/null || true
wait
