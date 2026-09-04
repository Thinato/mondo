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

provider "google" {
  region = var.region
}

provider "google-beta" {
  region = var.region
}
