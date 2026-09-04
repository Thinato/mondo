# Infrastructure

Terraform owns the durable shape of the GCP/Firebase project. The Firebase CLI
owns function source, `firestore.rules` and indexes — see `../backend/`. That
split is D-6: Terraform is good at project shape and bad at function deploys.

Everything here is safe to open-source. Project IDs, region names and the WIF
provider path are identifiers, not secrets. The one thing you must not commit is
`terraform.tfvars` (it names your billing account) and `terraform.tfstate`.

## Two irreversible decisions

Read these before your first `apply`.

1. **Firestore's location is permanent.** `southamerica-east1` cannot be changed
   later. Changing `var.region` after the fact does not move the database — it
   plans a destroy and recreate, taking every score with it. The database carries
   `prevent_destroy` and `DELETE_PROTECTION_ENABLED` so Terraform will refuse,
   which is the intended outcome.
2. **Firestore must be `FIRESTORE_NATIVE`.** A database that comes up in
   Datastore mode is invisible to the Firebase SDKs, to Auth and to Security
   Rules. Recovering means emptying and converting it. The config sets the type
   explicitly; verify it anyway (step 6).

## 1. Create the state bucket by hand

Terraform cannot create the bucket that stores its own state. Once, in a project
you already have — or in this one after step 3, moving state afterwards:

```sh
gcloud storage buckets create gs://mondo-tfstate-<something-unique> \
  --location=southamerica-east1 \
  --uniform-bucket-level-access \
  --public-access-prevention

# Versioning is the difference between a bad apply and a lost afternoon.
gcloud storage buckets update gs://mondo-tfstate-<something-unique> --versioning
```

```sh
cp backend.hcl.example backend.hcl     # gitignored
$EDITOR backend.hcl                    # put the bucket name in
```

## 2. Fill in variables

```sh
gcloud billing accounts list           # copy the ACCOUNT_ID column
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

The defaults in `variables.tf` are already right for Mondo. In practice
`billing_account` is the only value you must supply.

## 3. Apply

```sh
gcloud auth application-default login

terraform init -backend-config=backend.hcl
terraform plan -out=tf.plan
terraform apply tf.plan
```

The first apply takes 5–10 minutes, most of it enabling APIs. There is a
deliberate 60-second `time_sleep` after API enablement: without it the Firestore
and Identity Platform resources race the API being ready and fail on roughly
every other cold apply. If an apply does fail partway on a "not enabled" or
"consumer" error, wait a minute and re-run — it is idempotent.

## 4. Enable Google sign-in (the one manual step)

Terraform configures authorized domains and the email-link provider, but it
cannot enable the Google provider: that needs an OAuth 2.0 client, which Firebase
provisions for you when you flip the toggle and which Terraform has no clean way
to create.

> Firebase console → Authentication → Sign-in method → **Google** → Enable →
> set the support email → Save.

Confirm `lisecki.dev` and `localhost` are listed under Authentication → Settings
→ Authorized domains (Terraform sets these; check that nothing else is there).

## 5. Wire up CI

No JSON keys, ever (SEC-10). These are repository *variables*, not secrets —
none of them is sensitive:

```sh
gh variable set GCP_WIF_PROVIDER --body "$(terraform output -raw wif_provider)"
gh variable set GCP_DEPLOYER_SA  --body "$(terraform output -raw deployer_service_account)"
gh variable set GCP_PROJECT_ID   --body "$(terraform output -raw project_id)"
```

The WIF provider carries an attribute condition pinning it to
`Thinato/mondo`. No other repository on GitHub can mint a token for this project.

## 6. Verify before moving on

```sh
terraform output firestore_type        # must print FIRESTORE_NATIVE
terraform output firestore_location    # must print southamerica-east1
terraform output manual_steps
```

Then look at the console with your own eyes, because this is the irreversible
part:

- Firestore database exists, **Native mode**, `southamerica-east1`
- Billing budget of R$20 exists with alert thresholds (SEC-11)
- Authentication shows Google enabled and exactly two authorized domains

## 7. Frontend config

```sh
terraform output firebase_config
```

Paste those values into `../site/app/firebase.js`. They are not secret — a
Firebase web `apiKey` identifies the project and authorizes nothing. All access
control is Security Rules plus each callable's own auth assertion.

## What Terraform deliberately does not manage

| Thing | Why |
|---|---|
| The state bucket | Chicken-and-egg. Created by hand, step 1. |
| Google sign-in provider | Needs an OAuth client Terraform cannot cleanly create. Step 4. |
| Function source, `firestore.rules`, indexes | Firebase CLI's job (D-6). See `../backend/`. |
| The puzzle schedule | `tools/generate-schedule.mjs`, run by a human. Its output is the answers. |
