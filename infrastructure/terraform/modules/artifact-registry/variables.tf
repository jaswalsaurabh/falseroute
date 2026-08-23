variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "region" {
  type        = string
  description = "Artifact Registry location / region"
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry Docker repository ID"
  default     = "falseroute"
}

variable "reader_service_accounts" {
  type        = map(string)
  description = "Service account emails granted read access to pull images"
  default     = {}
}

variable "writer_service_accounts" {
  type        = map(string)
  description = "Service account emails granted write access to push images"
  default     = {}
}
