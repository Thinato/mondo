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
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app-check.js";

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

// SEC-18 / D-85 — App Check's reCAPTCHA Enterprise site key. Public, like the
// rest of this file: it is what Google checks the page's own domain against.
// From `cd infra && terraform output -raw app_check_site_key`. Empty means App
// Check is not started, which the server tolerates while APP_CHECK_ENFORCED is
// false — so this file can ship before the key exists.
const APP_CHECK_SITE_KEY = "6Lfd8uMtAAAAAOOfTXLy1aTYL8ZwoQOdUIFcw25b";

// Players are in São Paulo, and so is everything else (D-9).
const REGION = "southamerica-east1";

const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

// Locally, everything runs against the emulators under a demo project id, so a
// misconfigured call can never reach the real project by accident.
export const app = initializeApp(isLocal ? { ...firebaseConfig, projectId: "demo-mondo" } : firebaseConfig);

/**
 * Settles once App Check is running — or has been given up on. api.js awaits it
 * before every call, so the first getRound carries a token rather than racing
 * the script.
 *
 * reCAPTCHA is loaded HERE, not by the SDK, because the SDK's own loader has an
 * onload and no onerror: a browser that cannot fetch the script (a blocker, a
 * Pi-hole, a captive network) leaves its token promise pending for ever, and
 * every Auth and Functions request waits on that promise — a blank page, in
 * monitor mode too, and invisible to the server's APP_CHECK_MISSING because the
 * request is never sent. The SDK reuses a script that is already there. So: a
 * failure or four seconds of silence and the page plays on without App Check,
 * which monitor mode logs and enforcement (SEC-18) will refuse.
 *
 * isTokenAutoRefreshEnabled is off: tokens are fetched when a call needs one,
 * and the proactive refresh spends a second reCAPTCHA assessment on a player
 * who comes back the next day (docs/05-cost.md §3.5).
 */
export const appCheckReady = !isLocal && APP_CHECK_SITE_KEY ? startAppCheck() : Promise.resolve();

function startAppCheck() {
  return new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 4000);
    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/enterprise.js";
    script.async = true;
    script.onload = () => {
      clearTimeout(giveUp);
      if (window.grecaptcha?.enterprise) {
        initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: false });
      }
      resolve();
    };
    script.onerror = () => { clearTimeout(giveUp); resolve(); };
    document.head.append(script);
  });
}
export const auth = getAuth(app);
export const functions = getFunctions(app, REGION);
export const googleProvider = new GoogleAuthProvider();

/**
 * The Firestore SDK, for the one page that listens: sala.html (D-87). Loaded on
 * first use rather than imported above, so every other page goes on never
 * loading it — they read through callables, and a page that does not have the
 * SDK cannot be talked into a read the rules would have refused anyway.
 */
let firestore = null;
export function realtime() {
  firestore ??= import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js").then((fs) => {
    const db = fs.getFirestore(app);
    if (isLocal) fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    return { db, fs };
  });
  return firestore;
}

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  console.info("[mondo] using local emulators");
}
