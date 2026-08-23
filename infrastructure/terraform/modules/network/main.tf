# -----------------------------------------------------------------------------
# VPC and Subnet
# -----------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "falseroute-staging-vpc"
  auto_create_subnetworks = false
  description             = "Dedicated staging VPC for FalseRoute workloads"
}

resource "google_compute_subnetwork" "subnet" {
  project                  = var.project_id
  name                     = "falseroute-staging-subnet"
  ip_cidr_range            = "10.0.0.0/24"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
  description              = "Primary staging subnet with private Google access enabled"
}

# -----------------------------------------------------------------------------
# Serverless VPC Access Connector (Cloud Run to VPC egress)
# -----------------------------------------------------------------------------

resource "google_vpc_access_connector" "connector" {
  project        = var.project_id
  name           = "fr-staging-vpc-conn"
  region         = var.region
  ip_cidr_range  = "10.8.0.0/28"
  network        = google_compute_network.vpc.name
  min_throughput = 200
  max_throughput = 300
}

# -----------------------------------------------------------------------------
# Private Services Access (Cloud SQL VPC Peering)
# -----------------------------------------------------------------------------

resource "google_compute_global_address" "private_ip_alloc" {
  project       = var.project_id
  name          = "falseroute-staging-sql-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
  description   = "Reserved internal IP range for Cloud SQL private peering"
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_alloc.name]
}
