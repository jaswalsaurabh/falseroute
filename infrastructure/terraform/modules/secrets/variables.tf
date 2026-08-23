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

variable "database_url" {
  type        = string
  description = "PostgreSQL database connection URL"
  sensitive   = true
}

variable "operator_access_token" {
  type        = string
  description = "Operator access token for API authentication"
  sensitive   = true
}

variable "operator_replay_token" {
  type        = string
  description = "Elevated operator token for DLQ replay authorization"
  sensitive   = true
}

variable "gemini_api_key" {
  type        = string
  description = "Gemini API key for autonomous AI workflows"
  default     = ""
  sensitive   = true
}
