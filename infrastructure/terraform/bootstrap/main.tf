# =============================================================================
# FalseRoute Terraform State Storage Bootstrap Stack
# =============================================================================
# This standalone stack runs with local state to provision the remote GCS state
# storage bucket before the main FalseRoute staging infrastructure is initialized.
# =============================================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# -----------------------------------------------------------------------------
# Base APIs Required for State Storage
# -----------------------------------------------------------------------------

resource "google_project_service" "storage" {
  project                    = var.project_id
  service                    = "storage.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

# -----------------------------------------------------------------------------
# Remote Terraform State Storage Bucket
# -----------------------------------------------------------------------------

resource "google_storage_bucket" "tfstate" {
  project                     = var.project_id
  name                        = var.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}
