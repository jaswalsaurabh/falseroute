output "events_topic_id" {
  value       = google_pubsub_topic.events.id
  description = "The ID of the events Pub/Sub topic"
}

output "events_topic_name" {
  value       = google_pubsub_topic.events.name
  description = "The name of the events Pub/Sub topic"
}

output "dlq_topic_id" {
  value       = google_pubsub_topic.dlq.id
  description = "The ID of the DLQ Pub/Sub topic"
}

output "dlq_topic_name" {
  value       = google_pubsub_topic.dlq.name
  description = "The name of the DLQ Pub/Sub topic"
}

output "worker_subscription_id" {
  value       = google_pubsub_subscription.worker.id
  description = "The ID of the worker push subscription"
}

output "dlq_subscription_id" {
  value       = google_pubsub_subscription.dlq.id
  description = "The ID of the DLQ pull subscription"
}
