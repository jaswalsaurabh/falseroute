locals {
  common_labels = {
    app         = "falseroute"
    environment = var.environment
    managed_by  = "terraform"
    owner       = "saurabh-jaswal"
  }

  artifact_repository_id = "falseroute"
  pubsub_topic_id        = "falseroute-events"
  worker_oidc_audience   = "https://${var.domain_name}/worker"
}
