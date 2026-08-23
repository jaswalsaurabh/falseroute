variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "region" {
  type        = string
  description = "Google Cloud region"
}

variable "worker_service_url" {
  type        = string
  description = "Worker service URL for cleanup sweep endpoint"
}

variable "cleanup_sa_email" {
  type        = string
  description = "Dedicated service account email for executing cleanup sweeps"
}

variable "worker_oidc_audience" {
  type        = string
  description = "Expected audience for authenticated cleanup requests"
}
