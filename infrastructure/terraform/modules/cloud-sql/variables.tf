variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "region" {
  type        = string
  description = "Google Cloud region"
}

variable "vpc_id" {
  type        = string
  description = "VPC Network ID for private IP connectivity"
}

variable "enable_deletion_protection" {
  type        = bool
  description = "Enable deletion protection on Cloud SQL instance"
  default     = false
}

variable "database_tier" {
  type        = string
  description = "The tier for the Cloud SQL PostgreSQL instance"
  default     = "db-custom-1-3840"
}
