# -----------------------------------------------------------------------------
# Cloudflare DNS A Record for Staging
# -----------------------------------------------------------------------------

resource "cloudflare_record" "staging" {
  count   = var.enable_record && var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.record_name
  content = var.lb_ip_address
  type    = "A"
  proxied = var.proxied
  ttl     = var.ttl
  comment = "Managed by Terraform for FalseRoute staging HTTPS load balancer"
}
