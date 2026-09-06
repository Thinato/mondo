terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # Firebase resources are beta-only. Both providers are required; see README.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # Partial config: a backend block cannot read variables, so the bucket is
  # supplied at init time. The bucket is created by hand once (chicken-and-egg)
  # and never by this configuration. See README §1.
  #
  #   terraform init -backend-config=backend.hcl
  #
  backend "gcs" {
    prefix = "mondo/state"
  }
}

# user_project_override + billing_project: a handful of APIs (Identity Toolkit,
# Billing Budgets, Firebase) refuse user credentials unless the request names a
# quota project. Without these two lines, apply fails with a 403 "requires a
# quota project" on exactly those resources while everything else succeeds.
provider "google" {
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}
