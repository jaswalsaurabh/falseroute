# -----------------------------------------------------------------------------
# Pub/Sub Topics
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "events" {
  project = var.project_id
  name    = var.events_topic_id
}

resource "google_pubsub_topic" "dlq" {
  project = var.project_id
  name    = "falseroute-events-dlq"
}

resource "google_pubsub_topic_iam_member" "api_events_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.api_sa_email}"
}

# -----------------------------------------------------------------------------
# Worker Authenticated Push Subscription
# -----------------------------------------------------------------------------

resource "google_pubsub_subscription" "worker" {
  project              = var.project_id
  name                 = "falseroute-worker-sub"
  topic                = google_pubsub_topic.events.id
  ack_deadline_seconds = 60

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  push_config {
    push_endpoint = "${var.worker_service_url}/pubsub/push"

    oidc_token {
      service_account_email = var.pubsub_push_sa_email
      audience              = var.worker_oidc_audience
    }
  }
}

# -----------------------------------------------------------------------------
# Dead Letter Queue Push Subscription (durable inspection and replay intake)
# -----------------------------------------------------------------------------

resource "google_pubsub_subscription" "dlq" {
  project              = var.project_id
  name                 = "falseroute-events-dlq-sub"
  topic                = google_pubsub_topic.dlq.id
  ack_deadline_seconds = 60

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  push_config {
    push_endpoint = "${var.worker_service_url}/pubsub/dead-letter"

    oidc_token {
      service_account_email = var.pubsub_push_sa_email
      audience              = var.worker_oidc_audience
    }
  }
}

# -----------------------------------------------------------------------------
# Pub/Sub Service Agent IAM for Dead-Letter Topic Forwarding
# -----------------------------------------------------------------------------

# Google Pub/Sub service agent requires publisher role on the dead-letter topic
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Google Pub/Sub service agent requires subscriber role on the forwarding subscription
resource "google_pubsub_subscription_iam_member" "worker_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.worker.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
