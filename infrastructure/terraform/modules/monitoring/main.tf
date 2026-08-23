# -----------------------------------------------------------------------------
# Project lookup
# -----------------------------------------------------------------------------

data "google_project" "current" {
  project_id = var.project_id
}

# -----------------------------------------------------------------------------
# Notification Channel (Email)
# -----------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "FalseRoute Staging Billing & Incident Channel"
  type         = "email"

  labels = {
    email_address = var.incident_contact_email
  }
}

# -----------------------------------------------------------------------------
# Alert Policies for Staging
# -----------------------------------------------------------------------------

# 1. Cloud Run 5xx Server Errors Alert
resource "google_monitoring_alert_policy" "cloud_run_errors" {
  project      = var.project_id
  display_name = "FalseRoute Staging - Cloud Run 5xx Server Errors"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run 5xx error rate > 5%"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.name]
}

# 2. Cloud Run Readiness Probe Failures Alert
resource "google_monitoring_alert_policy" "cloud_run_readiness" {
  project      = var.project_id
  display_name = "FalseRoute Staging - Cloud Run Container Restarts/Readiness Failures"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run container instance restart rate"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/container/instance_count\" AND metric.labels.state = \"retired\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 3

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.name]
}

# 3. Pub/Sub Dead Letter Queue Backlog Alert
resource "google_monitoring_alert_policy" "pubsub_dlq_backlog" {
  project      = var.project_id
  display_name = "FalseRoute Staging - PubSub Dead Letter Queue Growth"
  combiner     = "OR"

  conditions {
    display_name = "Undelivered messages in Dead Letter Queue"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.name]
}

# 4. Cloud SQL Availability & Memory Saturation Alert
resource "google_monitoring_alert_policy" "cloud_sql_memory" {
  project      = var.project_id
  display_name = "FalseRoute Staging - Cloud SQL Memory Saturation (> 90%)"
  combiner     = "OR"

  conditions {
    display_name = "Cloud SQL memory utilization > 90%"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/memory/utilization\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.9

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.name]
}

# -----------------------------------------------------------------------------
# Cloud Billing Budget & Monetary Guardrails (ADR-0005 Section 4)
# -----------------------------------------------------------------------------

resource "google_billing_budget" "staging_budget" {
  billing_account = var.billing_account_id
  ownership_scope = "BILLING_ACCOUNT"
  # Cloud Billing budgets support monthly/yearly recurring periods, not daily.
  # Cloud Billing provides a monthly alert budget; the runtime spend budget
  # remains responsible for enforcing the daily ceiling.
  display_name = "FalseRoute staging alert"

  budget_filter {
    projects               = ["projects/${data.google_project.current.number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
    calendar_period        = "MONTH"
  }

  amount {
    specified_amount {
      currency_code = "INR"
      units         = "15000"
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

}
