# ==============================================================================
# Project
# ==============================================================================

resource "google_project" "main" {
  provider = google-beta

  name            = var.project_name
  project_id      = var.project_id
  billing_account = var.billing_account
  org_id          = var.org_id
  folder_id       = var.folder_id

  # Required for google_firebase_project to attach to this project.
  labels = {
    "firebase" = "enabled"
  }

  # Deleting the project would take every score with it — and now everything else
  # hosted on lisecki.dev too.
  deletion_policy = "PREVENT"
}

# ==============================================================================
# APIs
# ==============================================================================

locals {
  services = [
    "cloudresourcemanager.googleapis.com", # must be first; the rest depend on it
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # WIF token exchange
    "sts.googleapis.com",            # WIF token exchange
    "firebase.googleapis.com",
    "firebaserules.googleapis.com", # firestore.rules deploys
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com", # Firebase Auth / Identity Platform
    "cloudfunctions.googleapis.com",
    "run.googleapis.com",              # Functions v2 run on Cloud Run
    "cloudbuild.googleapis.com",       # builds the function source
    "artifactregistry.googleapis.com", # stores the built image
    "eventarc.googleapis.com",         # scheduled + event triggers
    "cloudscheduler.googleapis.com",   # rebuildStandings, scheduleHealthCheck
    "pubsub.googleapis.com",           # scheduler -> function plumbing
    "storage.googleapis.com",          # function source uploads, TF state
    "billingbudgets.googleapis.com",   # SEC-11
    "logging.googleapis.com",
  ]
}

resource "google_project_service" "services" {
  for_each = toset(local.services)

  project = google_project.main.project_id
  service = each.value

  # Leave APIs enabled on destroy. Disabling them can break other things in the
  # project and is never what you want during a teardown of this config.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# API enablement is eventually consistent. Without this, the first apply races
# and fails on Firestore or Identity Platform roughly half the time.
resource "time_sleep" "wait_for_services" {
  depends_on      = [google_project_service.services]
  create_duration = "60s"
}

# ==============================================================================
# Firebase
# ==============================================================================

resource "google_firebase_project" "mondo" {
  provider   = google-beta
  project    = google_project.main.project_id
  depends_on = [time_sleep.wait_for_services]
}

# ------------------------------------------------------------------------------
# Firestore
#
# TWO IRREVERSIBLE CHOICES, both called out in 02-architecture.md §7:
#
#   1. location_id is PERMANENT. It cannot be changed, only destroyed and
#      recreated — which means losing every attempt, result and standing.
#   2. type MUST be FIRESTORE_NATIVE. A database created in DATASTORE_MODE is
#      invisible to the Firebase SDKs, to Auth, and to Security Rules. Recovering
#      means emptying and converting it.
#
# Verify both in the console at the end of Phase 0 before writing any code
# against them.
# ------------------------------------------------------------------------------

resource "google_firestore_database" "default" {
  provider = google-beta

  project     = google_project.main.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Rules deploys and Admin SDK writes are the only write paths (SEC-6).
  concurrency_mode = "OPTIMISTIC"

  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  depends_on = [google_firebase_project.mondo]

  lifecycle {
    prevent_destroy = true
  }
}

# ------------------------------------------------------------------------------
# Web app
#
# Its config (apiKey, appId, …) is emitted by `terraform output firebase_config`
# and pasted into site/app/firebase.js. None of it is secret: a Firebase web
# apiKey is a project identifier, not a credential. Access control is entirely
# Security Rules plus the callable functions' own auth assertions (SEC-8).
# ------------------------------------------------------------------------------

resource "google_firebase_web_app" "mondo" {
  provider = google-beta

  project      = google_project.main.project_id
  display_name = "Mondo"

  deletion_policy = "DELETE"
  depends_on      = [google_firebase_project.mondo]
}

data "google_firebase_web_app_config" "mondo" {
  provider   = google-beta
  project    = google_project.main.project_id
  web_app_id = google_firebase_web_app.mondo.app_id
}

# ==============================================================================
# Identity Platform / Firebase Auth
#
# This sets the authorized domains (SEC-9) and sign-in policy. It does NOT
# enable the Google sign-in provider itself: that requires an OAuth 2.0 client,
# which Firebase auto-provisions when you flip the toggle in the console but
# Terraform cannot create for you. One manual step, documented in README §5.
#
# SHARED-PROJECT HAZARD: authorized_domains is authoritative for the entire
# project, not additive. Applying this replaces whatever is currently there. If
# another app on lisecki-dev signs users in from a domain not listed in
# var.authorized_domains, this apply breaks it. Check the console before the
# first apply.
# ==============================================================================

resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = google_project.main.project_id

  # lisecki.dev and localhost only. A sign-in started from anywhere else fails.
  authorized_domains = var.authorized_domains

  sign_in {
    allow_duplicate_emails = false

    # FR-1.1 fallback provider. The Google provider is enabled in the console.
    email {
      enabled           = true
      password_required = false # email-link sign-in, no password storage (D-5)
    }
  }

  depends_on = [time_sleep.wait_for_services]
}

# ==============================================================================
# Budget alert (SEC-11)
#
# Amount is in the billing account's own currency; currency_code is deliberately
# omitted so it inherits BRL rather than fighting the API over a mismatch.
#
# NOTE: the filter is the whole project, which now hosts everything on
# lisecki.dev. This alert therefore covers more than Mondo, and a breach does not
# necessarily mean Mondo caused it. See docs/05-cost.md §5.4.
# ==============================================================================

data "google_billing_account" "account" {
  billing_account = var.billing_account
}

resource "google_monitoring_notification_channel" "budget_email" {
  for_each = toset(var.budget_alert_emails)

  project      = google_project.main.project_id
  display_name = "lisecki.dev budget alert: ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [time_sleep.wait_for_services]
}

resource "google_billing_budget" "mondo" {
  billing_account = data.google_billing_account.account.id
  display_name    = "lisecki.dev — ${var.budget_amount}/month"

  budget_filter {
    projects               = ["projects/${google_project.main.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      units = tostring(var.budget_amount)
    }
  }

  # The expected steady-state bill is EXACTLY ZERO — Mondo is sized to sit inside
  # the free tier (NFR-3). So the interesting alert is not "you are near R$20",
  # it is "you are being charged at all". 5% of R$20 is R$1, which fires on
  # essentially any real spend and gives days of warning rather than hours.
  #
  # Read this as a smoke detector, not a spending cap. A budget alert NOTIFIES;
  # it does not stop charges. Nothing in GCP hard-caps spend by default.
  dynamic "threshold_rules" {
    for_each = [0.05, 0.25, 0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [
      for c in google_monitoring_notification_channel.budget_email : c.id
    ]
    disable_default_iam_recipients = false
  }
}
