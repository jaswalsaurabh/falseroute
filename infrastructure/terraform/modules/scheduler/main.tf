# -----------------------------------------------------------------------------
# Cloud Scheduler Cleanup Sweep Job
# -----------------------------------------------------------------------------

resource "google_cloud_scheduler_job" "cleanup" {
  project          = var.project_id
  region           = var.region
  name             = "falseroute-staging-cleanup"
  description      = "Scheduled sweep for expired FalseRoute leases and budget reservations"
  schedule         = "*/5 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
  }

  http_target {
    http_method = "POST"
    uri         = "${var.worker_service_url}/cleanup/leases"

    oidc_token {
      service_account_email = var.cleanup_sa_email
      audience              = var.worker_oidc_audience
    }
  }
}
