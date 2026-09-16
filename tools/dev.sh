#!/usr/bin/env bash
#
# Everything needed to play the local game, in one command:
#
#   tools/dev.sh
#
# Builds the functions, starts the emulators, seeds a week of puzzles, serves
# `site/`, and opens the browser. Ctrl-C stops all of it.
#
# The one thing it does that the real app never would: every profile it finds
# is granted `admin`, in a loop. Playing needs an invitation (FR-1.7, D-28) and
# a fresh emulator account has no group, so without this the first thing you
# see after signing in is "você precisa de um convite". It is scoped to the
# `demo-mondo` emulator and refuses to run against anything else.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG="$(mktemp -t mondo-emulators)"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"   # the Firestore emulator needs a JRE

cleanup() {
  echo ""
  echo "stopping…"
  # The whole process group: the emulators spawn a Java child that does not die
  # with its parent, and a stale Firestore emulator holding port 8080 is an
  # afternoon of confusion the next time someone runs the e2e suite.
  kill 0 2>/dev/null || true
  pkill -f "firebase-tools.*demo-mondo" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> building functions"
npm --prefix backend/functions run build

echo "==> starting emulators (log: $LOG)"
(cd backend && npx --yes firebase-tools@latest emulators:start \
  --project demo-mondo --only auth,firestore,functions >"$LOG" 2>&1) &

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
const db = admin.firestore();
(async () => {
  // A day is the four daily kinds (D-52, D-53). `flagPick` is deliberately not
  // among them (FR-8.6, D-64) — it is in the practice picker instead.
  const spec = { items: [{ kind: "shape", count: 1 }, { kind: "flag", count: 1 },
                         { kind: "capital", count: 1 }, { kind: "gdp", count: 1 }], order: "shuffled" };
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
(cd site && python3 -m http.server 8000 >/dev/null 2>&1) &

# Grant admin to whoever signs in. Polled rather than triggered, because the
# profile is written by the first getRound call and there is nothing to hook.
(cd backend/functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-mondo node -e '
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "demo-mondo" });
const db = admin.firestore();
setInterval(async () => {
  const snap = await db.collection("users").where("role", "!=", "admin").get().catch(() => null);
  for (const d of snap?.docs ?? []) {
    await d.ref.update({ role: "admin" });
    console.log("    granted admin to " + (d.data().displayName ?? d.id));
  }
}, 2000);
' 2>/dev/null) &

sleep 1
echo ""
echo "  treino (flagPick lives here):  http://localhost:8000/praticar.html"
echo "  o jogo do dia:                 http://localhost:8000/"
echo "  emulator UI:                   http://127.0.0.1:4000/"
echo ""
echo "  Sign in with Google → 'Add new account' → any email. Ctrl-C to stop."
open http://localhost:8000/praticar.html 2>/dev/null || true
wait
