variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "region" {
  type        = string
  description = "Google Cloud region"
}

variable "domain_name" {
  type        = string
  description = "Fully qualified domain name for FalseRoute staging"
}

variable "api_sa_email" {
  type        = string
  description = "API runtime service account email"
}

variable "worker_sa_email" {
  type        = string
  description = "Worker runtime service account email"
}

variable "web_sa_email" {
  type        = string
  description = "Web runtime service account email"
}

variable "pubsub_push_sa_email" {
  type        = string
  description = "Pub/Sub push service account email"
}

variable "cleanup_sa_email" {
  type        = string
  description = "Cleanup execution service account email"
}

variable "vpc_connector_id" {
  type        = string
  description = "VPC Access Connector ID for private egress"
}

variable "api_image_tag" {
  type        = string
  description = "Container image tag or digest for API service"
}

variable "worker_image_tag" {
  type        = string
  description = "Container image tag or digest for Worker service"
}

variable "web_image_tag" {
  type        = string
  description = "Container image tag or digest for Web service"
}

variable "api_event_publisher_mode" {
  type        = string
  description = "Event publisher mode for API runtime (must be LIVE_PUBSUB for production)"
  default     = "LIVE_PUBSUB"
}

variable "worker_autonomous_push_mode" {
  type        = string
  description = "Push mode for worker runtime (must be OIDC for production)"
  default     = "OIDC"
}

variable "worker_oidc_audience" {
  type        = string
  description = "Expected audience for Pub/Sub OIDC authentication on worker"
}

variable "pubsub_topic_id" {
  type        = string
  description = "Pub/Sub topic ID used by the API publisher"
}

variable "api_database_url_secret_id" {
  type        = string
  description = "Secret ID for API database URL"
}

variable "api_operator_token_secret_id" {
  type        = string
  description = "Secret ID for API operator access token"
}

variable "api_replay_token_secret_id" {
  type        = string
  description = "Secret ID for the elevated API replay token"
}

variable "worker_database_url_secret_id" {
  type        = string
  description = "Secret ID for Worker database URL"
}

variable "worker_gemini_key_secret_id" {
  type        = string
  description = "Secret ID for Worker Gemini API key"
  default     = null
  nullable    = true
}

variable "worker_gemini_model" {
  type        = string
  description = "Gemini model used for worker enrichment"
}

variable "worker_gemini_request_timeout_ms" {
  type        = number
  description = "Per-request Gemini timeout in milliseconds"
}

variable "worker_gemini_operation_deadline_ms" {
  type        = number
  description = "Total bounded Gemini operation deadline in milliseconds"
}

variable "worker_gemini_max_retries" {
  type        = number
  description = "Maximum bounded Gemini retries after the initial request"
}
