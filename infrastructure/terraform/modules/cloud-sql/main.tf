# -----------------------------------------------------------------------------
# Cloud SQL PostgreSQL 16 Instance (Private IP Only)
# -----------------------------------------------------------------------------

resource "random_password" "db_password" {
  length  = 24
  special = false
}

resource "google_sql_database_instance" "postgres" {
  project             = var.project_id
  name                = "falseroute-staging-db"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.enable_deletion_protection

  settings {
    tier              = var.database_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = var.vpc_id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = false
      transaction_log_retention_days = 3
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
    }
  }
}

# -----------------------------------------------------------------------------
# Database and Application User
# -----------------------------------------------------------------------------

resource "google_sql_database" "falseroute" {
  project   = var.project_id
  name      = "falseroute"
  instance  = google_sql_database_instance.postgres.name
  charset   = "UTF8"
  collation = "en_US.UTF8"
}

resource "google_sql_user" "app_user" {
  project  = var.project_id
  name     = "falseroute_app"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db_password.result
}
