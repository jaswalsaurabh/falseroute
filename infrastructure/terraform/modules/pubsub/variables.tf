variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "project_number" {
  type        = string
  description = "Google Cloud Project Number (used for service agent IAM)"
}

variable "worker_service_url" {
  type        = string
  description = "The target HTTPS URL of the Worker service for OIDC push delivery"
}

variable "worker_oidc_audience" {
  type        = string
  description = "Expected audience for Pub/Sub OIDC authentication"
}

variable "events_topic_id" {
  type        = string
  description = "Pub/Sub events topic ID"
  default     = "falseroute-events"
}

variable "pubsub_push_sa_email" {
  type        = string
  description = "Dedicated service account email used for authenticated Pub/Sub push delivery"
}

variable "api_sa_email" {
  type        = string
  description = "API service account allowed to publish validated events"
}

variable "worker_sa_email" {
  type        = string
  description = "Worker service account allowed to publish campaign continuation events"
}
