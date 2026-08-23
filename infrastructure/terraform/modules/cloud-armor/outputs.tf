output "policy_id" {
  value       = google_compute_security_policy.staging_armor.id
  description = "The ID of the Cloud Armor security policy"
}

output "policy_name" {
  value       = google_compute_security_policy.staging_armor.name
  description = "The name of the Cloud Armor security policy"
}
