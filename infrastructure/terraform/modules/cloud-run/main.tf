# -----------------------------------------------------------------------------
# FalseRoute API Cloud Run Service
# -----------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  project  = var.project_id
  name     = "falseroute-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false

  template {
    service_account                  = var.api_sa_email
    timeout                          = "60s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      connector = var.vpc_connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/falseroute/falseroute-api@${var.api_image_tag}"

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "EVENT_PUBLISHER_MODE"
        value = var.api_event_publisher_mode
      }
      env {
        name  = "PUBSUB_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "PUBSUB_TOPIC_ID"
        value = var.pubsub_topic_id
      }
      env {
        name  = "CORS_ORIGINS"
        value = "https://${var.domain_name}"
      }
      env {
        name  = "SHUTDOWN_TIMEOUT_MS"
        value = "8000"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.api_database_url_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPERATOR_ACCESS_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.api_operator_token_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPERATOR_REPLAY_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.api_replay_token_secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 5
        timeout_seconds       = 3
        http_get {
          path = "/api/v1/ready"
          port = 3000
        }
      }

      liveness_probe {
        period_seconds    = 15
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/api/v1/health"
          port = 3000
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# FalseRoute Worker Cloud Run Service
# -----------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "worker" {
  project          = var.project_id
  name             = "falseroute-worker"
  location         = var.region
  ingress          = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  custom_audiences = [var.worker_oidc_audience]
  deletion_protection = false

  template {
    service_account = var.worker_sa_email
    timeout         = "300s"

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    vpc_access {
      connector = var.vpc_connector_id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/falseroute/falseroute-worker@${var.worker_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "512Mi"
        }
        cpu_idle = false
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "AUTONOMOUS_PUSH_MODE"
        value = var.worker_autonomous_push_mode
      }
      env {
        name  = "PUBSUB_OIDC_SERVICE_ACCOUNT"
        value = var.pubsub_push_sa_email
      }
      env {
        name  = "PUBSUB_OIDC_AUDIENCE"
        value = var.worker_oidc_audience
      }
      env {
        name  = "CLEANUP_OIDC_SERVICE_ACCOUNT"
        value = var.cleanup_sa_email
      }
      env {
        name  = "WORKER_POLL_INTERVAL_MS"
        value = "500"
      }
      env {
        name  = "WORKER_CLAIM_LEASE_MS"
        value = "15000"
      }
      env {
        name  = "WORKER_CLAIM_PERSISTENCE_MARGIN_MS"
        value = "5000"
      }
      env {
        name  = "GEMINI_OPERATION_DEADLINE_MS"
        value = "8000"
      }
      env {
        name  = "WORKER_SHUTDOWN_TIMEOUT_MS"
        value = "8000"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.worker_database_url_secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = var.worker_gemini_key_secret_id == null ? [] : [var.worker_gemini_key_secret_id]
        content {
          name = "GEMINI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 5
        timeout_seconds       = 3
        http_get {
          path = "/ready"
          port = 8080
        }
      }

      liveness_probe {
        period_seconds    = 15
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# FalseRoute Web Cloud Run Service
# -----------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "web" {
  project  = var.project_id
  name     = "falseroute-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false

  template {
    service_account                  = var.web_sa_email
    timeout                          = "30s"
    max_instance_request_concurrency = 100

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/falseroute/falseroute-web@${var.web_image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1000m"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }
}

# -----------------------------------------------------------------------------
# Cloud Run Invoker IAM Bindings
# -----------------------------------------------------------------------------

# Allow allUsers on API and Web through Load Balancer
resource "google_cloud_run_v2_service_iam_member" "api_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "web_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Allow Pub/Sub push identity to invoke Worker
resource "google_cloud_run_v2_service_iam_member" "worker_push_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.pubsub_push_sa_email}"
}

# Allow Cleanup identity to invoke Worker cleanup endpoints
resource "google_cloud_run_v2_service_iam_member" "worker_cleanup_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.cleanup_sa_email}"
}
