output "bucket_name" {
  value       = google_storage_bucket.tfstate.name
  description = "The name of the provisioned GCS state bucket"
}

output "bucket_url" {
  value       = google_storage_bucket.tfstate.url
  description = "The gs:// URI of the provisioned GCS state bucket"
}
