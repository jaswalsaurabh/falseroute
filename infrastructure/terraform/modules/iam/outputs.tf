output "api_sa_email" {
  value       = google_service_account.api.email
  description = "Email of the API runtime service account"
}

output "api_sa_name" {
  value       = google_service_account.api.name
  description = "Fully qualified name of the API runtime service account"
}

output "worker_sa_email" {
  value       = google_service_account.worker.email
  description = "Email of the Worker runtime service account"
}

output "worker_sa_name" {
  value       = google_service_account.worker.name
  description = "Fully qualified name of the Worker runtime service account"
}

output "web_sa_email" {
  value       = google_service_account.web.email
  description = "Email of the Web runtime service account"
}

output "web_sa_name" {
  value       = google_service_account.web.name
  description = "Fully qualified name of the Web runtime service account"
}

output "cleanup_sa_email" {
  value       = google_service_account.cleanup.email
  description = "Email of the Cleanup execution service account"
}

output "cleanup_sa_name" {
  value       = google_service_account.cleanup.name
  description = "Fully qualified name of the Cleanup execution service account"
}

output "decoy_sa_email" {
  value       = google_service_account.decoy.email
  description = "Email of the Decoy runtime service account"
}

output "pubsub_push_sa_email" {
  value       = google_service_account.pubsub_push.email
  description = "Email of the Pub/Sub push subscription service account"
}
