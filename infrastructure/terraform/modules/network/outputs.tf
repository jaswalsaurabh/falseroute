output "vpc_id" {
  value       = google_compute_network.vpc.id
  description = "The ID of the VPC network"
}

output "vpc_name" {
  value       = google_compute_network.vpc.name
  description = "The name of the VPC network"
}

output "subnet_id" {
  value       = google_compute_subnetwork.subnet.id
  description = "The ID of the staging subnetwork"
}

output "vpc_connector_id" {
  value       = google_vpc_access_connector.connector.id
  description = "The ID of the Serverless VPC access connector"
}

output "private_vpc_connection" {
  value       = google_service_networking_connection.private_vpc_connection.id
  description = "The private VPC service networking peering connection ID"
}
