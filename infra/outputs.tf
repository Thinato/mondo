output "project_id" {
  description = "GCP / Firebase project ID."
  value       = google_project.mondo.project_id
}

output "project_number" {
  description = "GCP project number."
  value       = google_project.mondo.number
}

output "region" {
  description = "Region for Firestore, Functions and Scheduler."
  value       = var.region
}

output "firestore_location" {
  description = "Firestore location. PERMANENT — verify this in the console."
  value       = google_firestore_database.default.location_id
}

output "firestore_type" {
  description = "Must read FIRESTORE_NATIVE. Anything else and the Firebase SDKs cannot see the database."
  value       = google_firestore_database.default.type
}

# ------------------------------------------------------------------------------
# Frontend config
#
# Not secret. A Firebase web apiKey identifies the project; it does not authorize
# anything. Access control lives in Security Rules and in each callable's own
# auth assertion (SEC-6, SEC-8). Paste this into site/app/firebase.js.
# ------------------------------------------------------------------------------

output "firebase_config" {
  description = "Firebase web SDK config for site/app/firebase.js."
  value = {
    apiKey            = data.google_firebase_web_app_config.mondo.api_key
    authDomain        = data.google_firebase_web_app_config.mondo.auth_domain
    projectId         = google_project.mondo.project_id
    storageBucket     = try(data.google_firebase_web_app_config.mondo.storage_bucket, null)
    messagingSenderId = try(data.google_firebase_web_app_config.mondo.messaging_sender_id, null)
    appId             = google_firebase_web_app.mondo.app_id
  }
}

# ------------------------------------------------------------------------------
# GitHub Actions — set these as repository variables (not secrets; neither is one)
#
#   gh variable set GCP_WIF_PROVIDER   --body "$(terraform output -raw wif_provider)"
#   gh variable set GCP_DEPLOYER_SA    --body "$(terraform output -raw deployer_service_account)"
#   gh variable set GCP_PROJECT_ID     --body "$(terraform output -raw project_id)"
# ------------------------------------------------------------------------------

output "wif_provider" {
  description = "Full resource name of the WIF provider, for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Service account GitHub Actions impersonates. Has no keys."
  value       = google_service_account.deployer.email
}

output "functions_service_account" {
  description = "Runtime identity for the Cloud Functions."
  value       = google_service_account.functions.email
}

output "manual_steps" {
  description = "What Terraform cannot do for you."
  value       = <<-EOT
    1. Enable the Google sign-in provider:
       https://console.firebase.google.com/project/${google_project.mondo.project_id}/authentication/providers
       Terraform cannot create the OAuth client; Firebase provisions it on toggle.
    2. Verify Firestore is FIRESTORE_NATIVE in ${var.region}. This is irreversible:
       https://console.cloud.google.com/firestore/databases?project=${google_project.mondo.project_id}
    3. Confirm the budget alert exists:
       https://console.cloud.google.com/billing/budgets
  EOT
}
