// Firebase SDK init. Vanilla ES modules from the CDN — no bundler, no build
// step, ever (NFR-4, CLAUDE.md invariant 4).

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import {
  getFunctions,
  connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js";

// Not secret. A Firebase web apiKey identifies the project; it authorizes
// nothing. Every access decision is made by Security Rules and by each
// callable's own auth assertion (SEC-6, SEC-8). GitHub secret scanning flags
// it because it pattern-matches Google API keys — a false positive. The key IS
// referrer-restricted to lisecki.dev (infra/README.md §9), so it cannot be
// lifted and used from another site.
//
// Values come from:  cd infra && terraform output firebase_config
const firebaseConfig = {
  apiKey: "AIzaSyB8HUy2M-VJdz1RVnTOJYBfU4u7G7-5TfM",
  authDomain: "lisecki-dev.firebaseapp.com",
  projectId: "lisecki-dev",
  appId: "1:1004509196255:web:065a348a29d848fc6e1e6a",
};

// Players are in São Paulo, and so is everything else (D-9).
const REGION = "southamerica-east1";

const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app, REGION);
export const googleProvider = new GoogleAuthProvider();

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  console.info("[mondo] using local emulators");
}
