output "api_service_name" {
  value       = google_cloud_run_v2_service.api.name
  description = "The name of the API Cloud Run service"
}

output "api_service_uri" {
  value       = google_cloud_run_v2_service.api.uri
  description = "The URI of the API Cloud Run service"
}

output "worker_service_name" {
  value       = google_cloud_run_v2_service.worker.name
  description = "The name of the Worker Cloud Run service"
}

output "worker_service_uri" {
  value       = google_cloud_run_v2_service.worker.uri
  description = "The URI of the Worker Cloud Run service"
}

output "web_service_name" {
  value       = google_cloud_run_v2_service.web.name
  description = "The name of the Web Cloud Run service"
}

output "web_service_uri" {
  value       = google_cloud_run_v2_service.web.uri
  description = "The URI of the Web Cloud Run service"
}
