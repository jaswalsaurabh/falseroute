output "instance_name" {
  value       = google_sql_database_instance.postgres.name
  description = "The name of the Cloud SQL instance"
}

output "instance_connection_name" {
  value       = google_sql_database_instance.postgres.connection_name
  description = "The connection name of the Cloud SQL instance"
}

output "private_ip_address" {
  value       = google_sql_database_instance.postgres.private_ip_address
  description = "The private IP address of the Cloud SQL instance"
}

output "database_name" {
  value       = google_sql_database.falseroute.name
  description = "The application database name"
}

output "database_user" {
  value       = google_sql_user.app_user.name
  description = "The application database username"
}

output "database_password" {
  value       = random_password.db_password.result
  sensitive   = true
  description = "Generated database user password"
}
