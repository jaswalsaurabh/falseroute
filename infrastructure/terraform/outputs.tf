# =============================================================================
# FalseRoute Staging Infrastructure Outputs
# =============================================================================

output "project_id" {
  value       = var.project_id
  description = "Google Cloud Project ID"
}

output "region" {
  value       = var.region
  description = "Primary Google Cloud region"
}

output "staging_domain" {
  value       = var.domain_name
  description = "Staging public hostname"
}

output "load_balancer_ip" {
  value       = module.load_balancer.external_ip_address
  description = "External static IP address of the HTTPS load balancer"
}

output "artifact_registry_repository" {
  value       = module.artifact_registry.repository_id
  description = "Artifact Registry Docker repository ID"
}

output "cloud_sql_private_ip" {
  value       = module.cloud_sql.private_ip_address
  description = "Private IP address of the Cloud SQL PostgreSQL instance"
}

output "cloud_sql_instance_name" {
  value       = module.cloud_sql.instance_name
  description = "Cloud SQL instance name"
}

output "pubsub_events_topic" {
  value       = module.pubsub.events_topic_name
  description = "Pub/Sub events ingestion topic"
}

output "pubsub_dlq_topic" {
  value       = module.pubsub.dlq_topic_name
  description = "Pub/Sub dead-letter topic"
}

output "api_service_name" {
  value       = module.cloud_run.api_service_name
  description = "API Cloud Run service name"
}

output "worker_service_name" {
  value       = module.cloud_run.worker_service_name
  description = "Worker Cloud Run service name"
}

output "web_service_name" {
  value       = module.cloud_run.web_service_name
  description = "Web Cloud Run service name"
}

output "service_accounts" {
  value = {
    api         = module.iam.api_sa_email
    worker      = module.iam.worker_sa_email
    web         = module.iam.web_sa_email
    cleanup     = module.iam.cleanup_sa_email
    decoy       = module.iam.decoy_sa_email
    pubsub_push = module.iam.pubsub_push_sa_email
  }
  description = "Map of created least-privilege runtime service accounts"
}
