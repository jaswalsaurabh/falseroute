output "job_id" {
  value       = google_cloud_scheduler_job.cleanup.id
  description = "The ID of the Cloud Scheduler cleanup job"
}

output "job_name" {
  value       = google_cloud_scheduler_job.cleanup.name
  description = "The name of the Cloud Scheduler cleanup job"
}
