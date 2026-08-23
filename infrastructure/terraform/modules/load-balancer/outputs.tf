output "external_ip_address" {
  value       = google_compute_global_address.lb_ip.address
  description = "The external static IPv4 address of the load balancer"
}

output "url_map_id" {
  value       = google_compute_url_map.https.id
  description = "The ID of the HTTPS URL map"
}

output "ssl_certificate_id" {
  value       = google_compute_managed_ssl_certificate.cert.id
  description = "The ID of the Google-managed SSL certificate"
}
