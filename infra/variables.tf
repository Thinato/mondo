variable "project_id" {
  description = "GCP project ID. Globally unique, permanent. Shared by everything on lisecki.dev, not Mondo alone."
  type        = string
  default     = "lisecki-dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.project_id))
    error_message = "Project IDs are 6-30 chars, lowercase letters/digits/hyphens, starting with a letter."
  }
}

variable "project_name" {
  description = "Human-readable project name shown in the GCP console. No dots allowed."
  type        = string
  default     = "lisecki-dev"

  validation {
    condition     = can(regex("^[A-Za-z0-9 '\"!-]{4,30}$", var.project_name))
    error_message = "GCP display names are 4-30 chars of letters, digits, space, hyphen, quotes or '!'. No dots."
  }
}

variable "billing_account" {
  description = "Billing account ID, format XXXXXX-XXXXXX-XXXXXX. Find it with: gcloud billing accounts list"
  type        = string

  validation {
    condition     = can(regex("^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$", var.billing_account))
    error_message = "Expected the billing account ID (XXXXXX-XXXXXX-XXXXXX), not the full resource name."
  }
}

variable "org_id" {
  description = "Organization ID to create the project under. Leave null for a personal account with no organization."
  type        = string
  default     = null
}

variable "folder_id" {
  description = "Folder ID to create the project under. Mutually exclusive with org_id."
  type        = string
  default     = null
}

# --- Region -------------------------------------------------------------------
# WARNING: Firestore's location is PERMANENT once the database exists. Changing
# this variable after the first apply does not move the database; it destroys and
# recreates it, and Terraform will happily plan that. Roadmap Phase 0 step 4 says
# to verify this in the console before going further. Do that.

variable "region" {
  description = "Region for Firestore, Cloud Functions and Cloud Scheduler. PERMANENT for Firestore."
  type        = string
  default     = "southamerica-east1"
}

# --- Frontend -----------------------------------------------------------------

# WARNING: this list is AUTHORITATIVE for the whole project. Identity Platform
# replaces the project's authorized domains with exactly what is set here — it
# does not merge. Because lisecki-dev is shared by everything on lisecki.dev, any
# domain another app on this project relies on MUST appear in this list, or
# applying this config will break that app's sign-in.
variable "authorized_domains" {
  description = "EVERY domain allowed to complete a Firebase Auth sign-in for ANY app in this project. Authoritative, not additive. localhost is for the emulator (SEC-9)."
  type        = list(string)
  default     = ["lisecki.dev", "localhost"]
}

# --- Budget (SEC-11) ----------------------------------------------------------

variable "budget_amount" {
  description = "Monthly budget alert threshold, in the billing account's own currency (BRL). See OQ-9."
  type        = number
  default     = 20
}

variable "budget_alert_emails" {
  description = "Email addresses to notify on budget threshold breach. Empty means billing-account admins only."
  type        = list(string)
  default     = []
}

# --- CI / Workload Identity Federation (SEC-10) -------------------------------

variable "github_repository" {
  description = "owner/repo allowed to impersonate the deployer service account. Nothing else can."
  type        = string
  default     = "Thinato/mondo"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Expected owner/repo, e.g. Thinato/mondo."
  }
}
