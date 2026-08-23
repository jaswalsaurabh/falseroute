output "notification_channel_id" {
  value       = google_monitoring_notification_channel.email.id
  description = "The ID of the monitoring email notification channel"
}
