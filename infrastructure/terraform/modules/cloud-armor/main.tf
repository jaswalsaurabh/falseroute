# -----------------------------------------------------------------------------
# Cloud Armor Security Policy for FalseRoute Staging
# -----------------------------------------------------------------------------

resource "google_compute_security_policy" "staging_armor" {
  project     = var.project_id
  name        = "falseroute-staging-armor"
  description = "Dedicated staging Cloud Armor policy with reserved quarantine rule priority ranges [1000..1999]"

  # Default rule (Priority 2147483647)
  rule {
    action   = "allow"
    priority = "2147483647"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow rule for all traffic"
  }

  # Baseline Rate Limiting Rule (Priority 2000 - outside reserved 1000..1999 range)
  rule {
    action   = "rate_based_ban"
    priority = "2000"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 500
        interval_sec = 60
      }
      ban_duration_sec = 300
    }
    description = "Staging baseline rate limit: 500 req/min per client IP"
  }

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = false
    }
  }
}
