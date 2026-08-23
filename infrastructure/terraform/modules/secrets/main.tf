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
  count     = var.gemini_api_key != "" ? 1 : 0
  project   = var.project_id
  secret_id = "falseroute-worker-gemini-key"

  replication {
    auto {}
  }
}

# -----------------------------------------------------------------------------
# Secret Versions
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret_version" "api_database_url" {
  secret      = google_secret_manager_secret.api_database_url.id
  secret_data = var.database_url
}

resource "google_secret_manager_secret_version" "api_operator_token" {
  secret      = google_secret_manager_secret.api_operator_token.id
  secret_data = var.operator_access_token
}

resource "google_secret_manager_secret_version" "api_replay_token" {
  secret      = google_secret_manager_secret.api_replay_token.id
  secret_data = var.operator_replay_token
}

resource "google_secret_manager_secret_version" "worker_database_url" {
  secret      = google_secret_manager_secret.worker_database_url.id
  secret_data = var.database_url
}

resource "google_secret_manager_secret_version" "worker_gemini_key" {
  count       = var.gemini_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.worker_gemini_key[0].id
  secret_data = var.gemini_api_key
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
  count     = var.gemini_api_key != "" ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.worker_gemini_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.worker_sa_email}"
}
