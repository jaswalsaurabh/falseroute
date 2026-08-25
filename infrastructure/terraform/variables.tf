variable "project_id" {
  type        = string
  description = "The Google Cloud project ID for FalseRoute staging"
}

variable "project_number" {
  type        = string
  description = "The Google Cloud project number for FalseRoute staging"
}

variable "region" {
  type        = string
  description = "The primary Google Cloud region for FalseRoute staging resources"
  default     = "us-central1"
}

variable "environment" {
  type        = string
  description = "Deployment environment identifier"
  default     = "staging"
}

variable "domain_name" {
  type        = string
  description = "Fully qualified domain name for FalseRoute staging"
}

variable "technical_owner" {
  type        = string
  description = "Technical owner name"
}

variable "security_approver" {
  type        = string
  description = "Security and threat model approver"
}

variable "incident_contact_email" {
  type        = string
  description = "Contact email address for alerts, billing notifications, and incident response"
}

variable "adr_0005_accepted" {
  type        = bool
  description = "Records acceptance of ADR-0005 before staging infrastructure is provisioned. Runtime live effects additionally require activation evidence and an operator activation record."
  default     = false

  validation {
    condition     = var.adr_0005_accepted == true
    error_message = "ADR-0005 is accepted, but runtime live effects remain disabled until activation evidence and an operator activation record are complete. Set adr_0005_accepted = true in terraform.tfvars to record decision acceptance."
  }
}

variable "api_image_tag" {
  type        = string
  description = "Immutable sha256 image digest for the falseroute-api service"

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.api_image_tag))
    error_message = "api_image_tag must be an immutable lowercase sha256 digest."
  }
}

variable "worker_image_tag" {
  type        = string
  description = "Immutable sha256 image digest for the falseroute-worker service"

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.worker_image_tag))
    error_message = "worker_image_tag must be an immutable lowercase sha256 digest."
  }
}

variable "web_image_tag" {
  type        = string
  description = "Immutable sha256 image digest for the falseroute-web service"

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.web_image_tag))
    error_message = "web_image_tag must be an immutable lowercase sha256 digest."
  }
}

variable "billing_account_id" {
  type        = string
  description = "Google Cloud Billing Account ID for budget alerts (e.g., 012345-6789AB-CDEF01)"

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must use the 012345-6789AB-CDEF01 format."
  }
}

variable "enable_deletion_protection" {
  type        = bool
  description = "Enable deletion protection on Cloud SQL instance (recommended false for staging)"
  default     = false
}

variable "enable_cloudflare_dns" {
  type        = bool
  description = "Enable Cloudflare DNS record management via Terraform"
  default     = true
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare Zone ID for the staging example domain"
  default     = ""
}
