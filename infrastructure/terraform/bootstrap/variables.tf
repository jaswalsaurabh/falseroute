variable "project_id" {
  type        = string
  description = "The Google Cloud project ID for FalseRoute staging"
  default     = "falseroute-staging-example"
}

variable "region" {
  type        = string
  description = "The primary Google Cloud region for FalseRoute staging"
  default     = "us-central1"
}

variable "bucket_name" {
  type        = string
  description = "The globally unique name for the remote Terraform state GCS bucket"
  default     = "falseroute-staging-example-tfstate"
}
