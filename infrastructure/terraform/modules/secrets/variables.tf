variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "api_sa_email" {
  type        = string
  description = "API runtime service account email"
}

variable "worker_sa_email" {
  type        = string
  description = "Worker runtime service account email"
}
