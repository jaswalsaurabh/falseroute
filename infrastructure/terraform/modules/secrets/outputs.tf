output "api_database_url_secret_id" {
  value       = google_secret_manager_secret.api_database_url.secret_id
  description = "Secret ID for API database URL"
}

output "api_operator_token_secret_id" {
  value       = google_secret_manager_secret.api_operator_token.secret_id
  description = "Secret ID for API operator access token"
}

output "api_replay_token_secret_id" {
  value       = google_secret_manager_secret.api_replay_token.secret_id
  description = "Secret ID for elevated API replay authorization"
}

output "worker_database_url_secret_id" {
  value       = google_secret_manager_secret.worker_database_url.secret_id
  description = "Secret ID for Worker database URL"
}

output "worker_gemini_key_secret_id" {
  value       = google_secret_manager_secret.worker_gemini_key.secret_id
  description = "Secret ID for Worker Gemini API key"
}
