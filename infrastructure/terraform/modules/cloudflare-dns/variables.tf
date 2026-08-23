variable "enable_record" {
  type        = bool
  description = "Whether to create the Cloudflare DNS record"
  default     = true
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare Zone ID for easyvouch.in"
  default     = ""
}

variable "record_name" {
  type        = string
  description = "Subdomain name for the staging record"
  default     = "staging-falseroute"
}

variable "lb_ip_address" {
  type        = string
  description = "Target external IP address of the load balancer"
}

variable "proxied" {
  type        = bool
  description = "Whether the record receives Cloudflare proxy services (false recommended for direct Google-managed cert verification)"
  default     = false
}

variable "ttl" {
  type        = number
  description = "TTL for the DNS record in seconds (1 for auto)"
  default     = 300
}
