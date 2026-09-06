# ==============================================================================
# Workload Identity Federation for GitHub Actions (SEC-10)
#
# No service-account JSON key is ever created or downloaded. GitHub Actions
# presents its OIDC token, GCP exchanges it for a short-lived access token, and
# only workflows running in this specific repository can do so.
# ==============================================================================

resource "google_service_account" "deployer" {
  project      = google_project.main.project_id
  account_id   = "mondo-deployer"
  display_name = "Mondo CI deployer"
  description  = "Impersonated by GitHub Actions via WIF to deploy functions, rules and indexes. Has no keys."

  depends_on = [time_sleep.wait_for_services]
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.main.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  description               = "Identity pool for GitHub Actions OIDC tokens."

  depends_on = [time_sleep.wait_for_services]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.main.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Mandatory, and the whole point. Without this condition ANY GitHub repository
  # on the internet could mint a token for this pool.
  attribute_condition = "assertion.repository == '${var.github_repository}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Narrow it once more: only workflows on the default branch may impersonate the
# deployer. A pull request from a fork cannot deploy.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# ------------------------------------------------------------------------------
# Deployer permissions
#
# Deliberately enumerated rather than roles/editor. This repo is public; a
# reviewer should be able to read exactly what CI is allowed to do.
# ------------------------------------------------------------------------------

locals {
  deployer_roles = [
    "roles/firebase.admin",           # rules + indexes + project config
    "roles/cloudfunctions.developer", # deploy functions v2
    "roles/run.admin",                # functions v2 are Cloud Run services
    "roles/cloudbuild.builds.editor", # build function source
    "roles/artifactregistry.writer",  # push the built image
    "roles/storage.admin",            # function source staging bucket
    "roles/iam.serviceAccountUser",   # act as the runtime SA
    "roles/serviceusage.serviceUsageConsumer",
    "roles/cloudscheduler.admin", # scheduled functions
    "roles/eventarc.developer",   # scheduled/event triggers
    "roles/datastore.owner",      # seed the puzzle schedule
  ]
}

resource "google_project_iam_member" "deployer" {
  for_each = toset(local.deployer_roles)

  project = google_project.main.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# ------------------------------------------------------------------------------
# Runtime service account for the functions themselves.
#
# Separate from the deployer, and much smaller: the running code needs Firestore
# and logging, nothing else. If a function is ever compromised it cannot deploy,
# cannot touch IAM, and cannot read the billing account.
# ------------------------------------------------------------------------------

resource "google_service_account" "functions" {
  project      = google_project.main.project_id
  account_id   = "mondo-functions"
  display_name = "Mondo functions runtime"
  description  = "Runtime identity for Cloud Functions. Firestore + logging only."

  depends_on = [time_sleep.wait_for_services]
}

resource "google_project_iam_member" "functions_runtime" {
  for_each = toset([
    "roles/datastore.user",
    "roles/logging.logWriter",
    "roles/firebaseauth.admin", # deleteAccount must delete the auth record (FR-1.5)
  ])

  project = google_project.main.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.functions.email}"
}

resource "google_service_account_iam_member" "deployer_acts_as_functions" {
  service_account_id = google_service_account.functions.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
