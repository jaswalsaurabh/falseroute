# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "falseroute-api-sa"
  display_name = "FalseRoute API Runtime Identity"
  description  = "Least-privilege runtime service account for FalseRoute API"
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "falseroute-worker-sa"
  display_name = "FalseRoute Worker Runtime Identity"
  description  = "Least-privilege runtime service account for FalseRoute Worker"
}

resource "google_service_account" "web" {
  project      = var.project_id
  account_id   = "falseroute-web-sa"
  display_name = "FalseRoute Web Runtime Identity"
  description  = "Least-privilege runtime service account for FalseRoute Web UI"
}

resource "google_service_account" "cleanup" {
  project      = var.project_id
  account_id   = "falseroute-cleanup-sa"
  display_name = "FalseRoute Cleanup Execution Identity"
  description  = "Dedicated execution service account for scheduled cleanup sweeps"
}

resource "google_service_account" "decoy" {
  project      = var.project_id
  account_id   = "falseroute-decoy-sa"
  display_name = "FalseRoute Decoy Runtime Identity (Zero Permissions)"
  description  = "Simulated containment decoy identity with strictly zero cloud IAM permissions"
}

resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "falseroute-pubsub-push-sa"
  display_name = "FalseRoute PubSub Push Identity"
  description  = "Dedicated authenticated identity for Pub/Sub push subscription dispatch"
}

# -----------------------------------------------------------------------------
# Least-Privilege Project IAM Bindings
# -----------------------------------------------------------------------------

# API Runtime Roles
locals {
  api_roles = [
    "roles/cloudsql.client",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]

  worker_roles = [
    "roles/cloudsql.client",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]

  web_roles = [
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]

}

resource "google_project_iam_member" "api_roles" {
  for_each = toset(local.api_roles)

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_roles" {
  for_each = toset(local.worker_roles)

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_project_iam_member" "web_roles" {
  for_each = toset(local.web_roles)

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.web.email}"
}

# -----------------------------------------------------------------------------
# Service Agent Token Creator Bindings (for OIDC token minting)
# -----------------------------------------------------------------------------

# Allow Pub/Sub service agent to mint OIDC tokens for the push SA
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Allow Cloud Scheduler service agent to mint OIDC tokens for the cleanup SA
resource "google_service_account_iam_member" "scheduler_token_creator" {
  service_account_id = google_service_account.cleanup.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}
