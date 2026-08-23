# -----------------------------------------------------------------------------
# Secret Manager Containers (Payloads managed out of band)
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "api_database_url" {
  project   = var.project_id
  secret_id = "falseroute-api-database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "api_operator_token" {
  project   = var.project_id
  secret_id = "falseroute-api-operator-token"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "api_replay_token" {
  project   = var.project_id
  secret_id = "falseroute-api-replay-token"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "worker_database_url" {
  project   = var.project_id
  secret_id = "falseroute-worker-database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "worker_gemini_key" {
  project   = var.project_id
  secret_id = "falseroute-worker-gemini-key"

  replication {
    auto {}
  }
}

# -----------------------------------------------------------------------------
# Secret Accessor IAM Bindings
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "api_db_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.api_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_sa_email}"
}

resource "google_secret_manager_secret_iam_member" "api_token_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.api_operator_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_sa_email}"
}

resource "google_secret_manager_secret_iam_member" "api_replay_token_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.api_replay_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.api_sa_email}"
}

resource "google_secret_manager_secret_iam_member" "worker_db_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.worker_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.worker_sa_email}"
}

resource "google_secret_manager_secret_iam_member" "worker_gemini_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.worker_gemini_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.worker_sa_email}"
}
