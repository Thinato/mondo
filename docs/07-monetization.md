# Monetization — where it stands and what is left

Last updated 2026-10-10. Read this first when picking monetization back up — most likely the
day AdSense approves the site. Decisions live in `00-brief.md` (D-83 to D-85), requirements in
`01-requirements.md` (FR-10, FR-11, SEC-18). This file is the to-do list that ties them together.

## 1. Done

| Step | What | Where |
|---|---|---|
| Private repo | Repo private on GitHub Pro; licence all-rights-reserved from 2026-10-04; third-party attributions public on `site/creditos.html` | D-83, PR #22 |
| Ranks | `admin` · `invited` · `subscriber` · `user` · `guest`; anyone signed in plays; Invited is a closed list; inviting needs the group **and** the rank | D-84, FR-10, PR #23 |
| Migration | `tools/migrate-tiers.mjs --apply` ran in production on 2026-10-07; no legacy role is left | D-84 |
| Guests | Every visitor is signed in anonymously at first load; "Entrar com Google" upgrades them in place (`linkWithPopup`, same uid) | D-85, PR #23 |
| App Check | reCAPTCHA Enterprise on every callable, **monitor mode** (`APP_CHECK_ENFORCED = false`) | SEC-18, D-85, PR #24 |
| AdSense account | Publisher `ca-pub-6009839763524724`; `lisecki.dev/ads.txt` live; site ownership verified 2026-10-08; **review pending** | `Thinato/thinato.github.io` PRs #1, #2 |

Already in the backend but **not yet used by any page**: `me.rank` and `me.ads` on `getRound` and
`listGroups`, and the admin's `setShowAds` callable.

## 2. Decisions taken

- **Invited is a closed list.** Accepting an invite grants membership, never a rank. Only an
  admin's `setRole` adds someone to it now (FR-10.2).
- **A lapsed subscriber, or a user who inherits a group (D-23), keeps the group playing and cannot
  invite** (FR-10.3). Links minted before the lapse stop working too.
- **Guests play and practise but cannot join or create groups** (FR-10.5).
- **Payments: Stripe.** Do not use the Firebase "Run Payments with Stripe" extension: it creates
  checkout sessions by client Firestore writes, which breaks invariant 2.
- **Ads are display, never security.** `me.ads` decides what is drawn; a page whose `me.ads` is
  false must not load an ad script at all (FR-10.4).

## 3. Waiting on

| Blocker | Unblocks | Who |
|---|---|---|
| AdSense approves `lisecki.dev` | Step B (ads) | Google |
| CPF or CNPJ/MEI, and who issues the nota fiscal | Step C (Stripe account and prices) | Paulo |
| Silhouette artwork licence (NOTICE: source and licence unknown; `creditos.html` invites the author to come forward) | Peace of mind before the game earns money | Paulo |

## 4. Next steps, in order

### A. Enforce App Check (can be done now)

1. Check that the real site always sends a token:
   ```sh
   gcloud logging read 'jsonPayload.message="APP_CHECK_MISSING"' \
     --project lisecki-dev --freshness 3d --limit 50 \
     --format 'value(timestamp, jsonPayload.origin)'
   ```
   It is safe to enforce when what is left is strays — no `https://lisecki.dev` origin, or a
   handful from stale tabs — and not a steady stream from the real site.
2. Set `APP_CHECK_ENFORCED = true` in `backend/functions/src/lib/config.ts`, in a commit of its own.
   Merging deploys it.
3. Right after the deploy: play one challenge as a guest and one signed in, then check that
   `APP_CHECK_MISSING` has not turned into a run of refusals. To roll back, flip the constant back.

### B. Ads — the day AdSense approves

**Housekeeping on `lisecki.dev`** (`Thinato/thinato.github.io`):
- [ ] Remove the `adsbygoogle.js` `<script>` from the homepage. It was only there to verify the
      site, because the meta tag would not verify.
- [ ] Keep **Auto ads OFF** in the AdSense console. Auto ads would place ads by themselves, on
      every page including the ad-free players' pages and next to the guess input.
- [ ] Keep `ads.txt` in place.

**Consent:**
- [ ] AdSense → Privacy & messaging: publish the GDPR message (EEA/UK/CH visitors; Google requires
      a certified CMP and this is Google's own, free). Consider the same message for Brazil (LGPD).

**Code** (`site/`, no build step, invariant 4):
- [ ] `site/app/ads.js`: inject `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6009839763524724`
      **only after identity has resolved and only if `me.ads` is true**. The default is no ads, so
      an ad-free player never makes a request to Google's ad servers. `me` comes from `getRound`
      on the daily and from `listGroups` everywhere else (`auth-ui.js` `identify`).
- [ ] Ad slots (manual units, not Auto ads):
  - below the day's result/recap once the day is over;
  - on `regras.html`;
  - between practice challenges, after the reveal.
  - **Never** next to the guess input or the eight options of a pick challenge: that breaks
    AdSense's accidental-click policy, and a mis-tap costs a guess.
  - Check every slot on a phone against the tab bar (FR-6.1).
- [ ] Admin opt-in UI: a "Ver anúncios" switch in the Perfil dialog, drawn only for `me.role === "admin"`
      and calling `setShowAds`. The callable already exists.

**Words:**
- [ ] `privacidade.html` still says *"Não há anúncios e não há analytics além do log de erros do
      servidor."* Rewrite it to cover: ads for users and guests only; Google as a third party;
      cookies and consent; what an ad-free tier means; how to opt out.
- [ ] `NOTICE` (top), `CLAUDE.md` (the D-78 photo bullet) and `privacidade.html` ("Onde fica")
      each list the third parties a page reaches at play time: today Wikimedia and reCAPTCHA. Add
      Google's ad servers to all three, saying they load only for users and guests.
- [ ] `regras.html`: one short paragraph on who sees ads and why.
- [ ] Admin panel reading guide: an ad click blurs the window and so shows up in the SEC-16
      self-report. That is noise to read past, not a cheating signal.

**Checks before merging:**
- [ ] As an invited player: the Network tab shows **no** request to `googlesyndication.com`.
- [ ] As a guest and as a user: ads render in the slots above and nowhere else.
- [ ] As an admin: off by default; on after the switch; off again.
- [ ] Opening a page from an EEA VPN shows the consent message first.
- [ ] The answer is still nowhere in the DOM (invariant 1). An ad script can read the page.

### C. Subscriptions with Stripe — once CPF/CNPJ is decided

**Account (Paulo):**
- [ ] A Stripe Brazil account; a monthly price in BRL (and a yearly one, if wanted).
- [ ] Payment methods in Checkout: card, plus **Pix Automático**, which Stripe supports for
      subscriptions since 2026-04-22. Google Pay and Apple Pay come with Checkout.
- [ ] Customer Portal enabled: cancel, change card, invoices.
- [ ] Webhook endpoint for the events listed below; its signing secret goes to Secret Manager.

**Backend** (`backend/functions/src/`):
- [ ] `createCheckoutSession` (callable) → Stripe Checkout URL with `client_reference_id = uid`.
  - Refuse a `guest`: they must link Google first, or the subscription would belong to a browser.
  - Refuse an `invited` or `admin`: they are already ad-free.
- [ ] `createPortalSession` (callable) → Customer Portal URL for a caller with a Stripe customer id.
- [ ] `stripeWebhook` — an **`onRequest`** HTTP function, the first entry point that is not a
      callable. It breaks a convention on purpose and needs its own D-number.
  - Verify the Stripe signature before reading anything.
  - Handle `checkout.session.completed`, `customer.subscription.updated` and
    `customer.subscription.deleted`.
  - Write `users/{uid}.subscription = { status, currentPeriodEnd }` (FR-11.1) plus the customer
    and subscription ids, with the Admin SDK.
  - Be idempotent on event id.
  - Store `currentPeriodEnd` as a Firestore **Timestamp**. `rankOf` treats anything else as no
    subscription.
- [ ] Secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` via `defineSecret`, never the repo
      (invariant 5, SEC-10). Grant the runtime service account access in Terraform.
- [ ] `deleteAccount` must **cancel the Stripe subscription before deleting anything** (FR-1.5).
      Otherwise a deleted account keeps getting billed.
- [ ] `listUsers` (admin) shows the rank and subscription status.
- [ ] Rules: `subscription` is already client-unwritable (`hasOnly(['displayName','locale'])`), and
      `test/rules` pins it.

**Frontend:**
- [ ] `assinar.html`: price, what you get (no ads, create groups, invite), Pix or card, and the
      7-day right of withdrawal (CDC art. 49).
- [ ] "Assinar" entry point for `user` and `guest`. A guest is asked to sign in with Google first.
- [ ] "Gerenciar assinatura" in the Perfil dialog for subscribers, opening the Customer Portal.

**Words:**
- [ ] `privacidade.html`: Stripe as processor; what is stored (Stripe ids, status, period end —
      never card data).
- [ ] Terms of sale or a refund line, as the CPF/CNPJ decision requires.

**Checks (Stripe test mode, emulator first):**
- [ ] Checkout → webhook → `rank` is `subscriber`, `me.ads` is false, and creating a group works.
- [ ] Cancel in the Portal → still a subscriber until the period ends → then `user` with ads again,
      with no webhook needed for that last step.
- [ ] A replayed webhook changes nothing.
- [ ] Deleting the account cancels the Stripe subscription.

### D. Scale and cost — before sharing the link widely

- [ ] Practice has no per-player ceiling (`05-cost.md` §2). Revisit its throttle now that anyone
      can drill.
- [ ] Anonymous accounts pile up. They count toward Identity Platform MAU, and their profiles,
      attempts and practice sessions are orphaned once the browser forgets them. Turn on
      anonymous-account cleanup if Identity Platform offers it, and delete their Firestore data
      with them (or add a TTL).
- [ ] Raise the budget alert (`infra/variables.tf` `budget_amount`) to match real traffic.
- [ ] Re-read `05-cost.md` §2 with a week of public numbers. Its table assumes 100 invited players.

## 5. Do not undo

- **Do not make joining a group grant `invited`** — every invited player could then make anyone
  ad-free (D-84).
- **Do not store `guest` or `subscriber` as a role** — both are derived so that nothing has to
  remember to demote them (FR-10.1).
- **Do not load the ad script before `me` arrives, or when `me.ads` is false** (FR-10.4).
- **Do not turn on Auto ads.** Placement is a game-design decision here, not Google's.
- **Do not link the private repo from `site/`, and add any new data source to both `NOTICE` and
  `creditos.html`** (D-83).
