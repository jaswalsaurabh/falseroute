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
  description = "Domain name for staging routing and SSL certificate"
}

variable "api_service_name" {
  type        = string
  description = "Cloud Run API service name"
}

variable "web_service_name" {
  type        = string
  description = "Cloud Run Web service name"
}

variable "cloud_armor_policy_id" {
  type        = string
  description = "Cloud Armor Security Policy ID"
}
