output "enabled_services" {
  value       = [for s in google_project_service.enabled_services : s.service]
  description = "List of enabled Google Cloud APIs"
}
