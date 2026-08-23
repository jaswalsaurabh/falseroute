# -----------------------------------------------------------------------------
# Global Static IP
# -----------------------------------------------------------------------------

resource "google_compute_global_address" "lb_ip" {
  project      = var.project_id
  name         = "falseroute-staging-lb-ip"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
  description  = "Global static IP address for FalseRoute staging external load balancer"
}

# -----------------------------------------------------------------------------
# Serverless Network Endpoint Groups (NEGs)
# -----------------------------------------------------------------------------

resource "google_compute_region_network_endpoint_group" "api_neg" {
  project               = var.project_id
  name                  = "falseroute-api-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = var.api_service_name
  }
}

resource "google_compute_region_network_endpoint_group" "web_neg" {
  project               = var.project_id
  name                  = "falseroute-web-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = var.web_service_name
  }
}

# -----------------------------------------------------------------------------
# Backend Services
# -----------------------------------------------------------------------------

resource "google_compute_backend_service" "api_backend" {
  project         = var.project_id
  name            = "falseroute-api-backend"
  protocol        = "HTTP"
  port_name       = "http"
  enable_cdn      = false
  security_policy = var.cloud_armor_policy_id

  backend {
    group = google_compute_region_network_endpoint_group.api_neg.id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_backend_service" "web_backend" {
  project         = var.project_id
  name            = "falseroute-web-backend"
  protocol        = "HTTP"
  port_name       = "http"
  enable_cdn      = false
  security_policy = var.cloud_armor_policy_id

  backend {
    group = google_compute_region_network_endpoint_group.web_neg.id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# -----------------------------------------------------------------------------
# HTTPS URL Map and Managed Certificate
# -----------------------------------------------------------------------------

resource "google_compute_managed_ssl_certificate" "cert" {
  project = var.project_id
  name    = "falseroute-staging-cert"

  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "falseroute-staging-url-map"
  default_service = google_compute_backend_service.web_backend.id

  host_rule {
    hosts        = [var.domain_name]
    path_matcher = "staging-paths"
  }

  path_matcher {
    name            = "staging-paths"
    default_service = google_compute_backend_service.web_backend.id

    path_rule {
      paths   = ["/api", "/api/*"]
      service = google_compute_backend_service.api_backend.id
    }
  }
}

resource "google_compute_target_https_proxy" "proxy" {
  project          = var.project_id
  name             = "falseroute-staging-https-proxy"
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.cert.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "falseroute-staging-https-fwd-rule"
  ip_address            = google_compute_global_address.lb_ip.address
  target                = google_compute_target_https_proxy.proxy.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL"
}

# -----------------------------------------------------------------------------
# HTTP to HTTPS Redirect
# -----------------------------------------------------------------------------

resource "google_compute_url_map" "http_redirect" {
  project = var.project_id
  name    = "falseroute-staging-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http" {
  project = var.project_id
  name    = "falseroute-staging-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "falseroute-staging-http-fwd-rule"
  ip_address            = google_compute_global_address.lb_ip.address
  target                = google_compute_target_http_proxy.http.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
