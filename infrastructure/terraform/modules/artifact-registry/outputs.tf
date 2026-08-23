output "repository_id" {
  value       = google_artifact_registry_repository.repo.repository_id
  description = "The ID of the Artifact Registry repository"
}

output "repository_name" {
  value       = google_artifact_registry_repository.repo.name
  description = "The fully qualified resource name of the Artifact Registry repository"
}
