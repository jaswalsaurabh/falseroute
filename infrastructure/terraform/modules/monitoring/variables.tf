variable "project_id" {
  type        = string
  description = "Google Cloud Project ID"
}

variable "project_number" {
  type        = string
  description = "Google Cloud Project Number"
  default     = ""
}

variable "billing_account_id" {
  type        = string
  description = "Google Cloud Billing Account ID for budget alerts"
}

variable "incident_contact_email" {
  type        = string
  description = "Email address for incident notifications and alert delivery"
}

variable "dlq_topic_name" {
  type        = string
  description = "Name of the Pub/Sub dead-letter topic to monitor"
}
