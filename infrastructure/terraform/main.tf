# =============================================================================
# FalseRoute Staging Infrastructure Stack
# =============================================================================

# -----------------------------------------------------------------------------
# Module: Project Services
# -----------------------------------------------------------------------------

module "project_services" {
  source = "./modules/project-services"

  project_id = var.project_id
}

# -----------------------------------------------------------------------------
# Module: Service Accounts & IAM
# -----------------------------------------------------------------------------

module "iam" {
  source = "./modules/iam"

  project_id     = var.project_id
  project_number = var.project_number

  depends_on = [module.project_services]
}

# -----------------------------------------------------------------------------
# Module: Artifact Registry
# -----------------------------------------------------------------------------

module "artifact_registry" {
  source = "./modules/artifact-registry"

  project_id    = var.project_id
  region        = var.region
  repository_id = local.artifact_repository_id

  reader_service_accounts = {
    api    = module.iam.api_sa_email
    worker = module.iam.worker_sa_email
    web    = module.iam.web_sa_email
  }

  writer_service_accounts = {}

  depends_on = [module.project_services]
}

# -----------------------------------------------------------------------------
# Module: VPC Networking & Private Service Connectors
# -----------------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  project_id = var.project_id
  region     = var.region

  depends_on = [module.project_services]
}

# -----------------------------------------------------------------------------
# Module: Cloud SQL PostgreSQL 16 (Private IP Only)
# -----------------------------------------------------------------------------

module "cloud_sql" {
  source = "./modules/cloud-sql"

  project_id                 = var.project_id
  region                     = var.region
  vpc_id                     = module.network.vpc_id
  enable_deletion_protection = var.enable_deletion_protection

  depends_on = [module.project_services, module.network]
}

# -----------------------------------------------------------------------------
# Module: Secret Manager Containers
# -----------------------------------------------------------------------------

module "secrets" {
  source = "./modules/secrets"

  project_id      = var.project_id
  api_sa_email    = module.iam.api_sa_email
  worker_sa_email = module.iam.worker_sa_email

  depends_on = [module.project_services, module.cloud_sql]
}

# -----------------------------------------------------------------------------
# Module: Cloud Run Services (API, Worker, Web)
# -----------------------------------------------------------------------------

module "cloud_run" {
  source = "./modules/cloud-run"

  project_id                    = var.project_id
  region                        = var.region
  domain_name                   = var.domain_name
  api_sa_email                  = module.iam.api_sa_email
  worker_sa_email               = module.iam.worker_sa_email
  web_sa_email                  = module.iam.web_sa_email
  pubsub_push_sa_email          = module.iam.pubsub_push_sa_email
  cleanup_sa_email              = module.iam.cleanup_sa_email
  vpc_connector_id              = module.network.vpc_connector_id
  api_image_tag                 = var.api_image_tag
  worker_image_tag              = var.worker_image_tag
  web_image_tag                 = var.web_image_tag
  api_database_url_secret_id    = module.secrets.api_database_url_secret_id
  api_operator_token_secret_id  = module.secrets.api_operator_token_secret_id
  api_replay_token_secret_id    = module.secrets.api_replay_token_secret_id
  worker_database_url_secret_id = module.secrets.worker_database_url_secret_id
  worker_gemini_key_secret_id   = module.secrets.worker_gemini_key_secret_id
  worker_oidc_audience          = local.worker_oidc_audience
  pubsub_topic_id               = local.pubsub_topic_id

  depends_on = [
    module.project_services,
    module.iam,
    module.network,
    module.secrets,
  ]
}

# -----------------------------------------------------------------------------
# Module: Pub/Sub Messaging
# -----------------------------------------------------------------------------

module "pubsub" {
  source = "./modules/pubsub"

  project_id           = var.project_id
  project_number       = var.project_number
  worker_service_url   = module.cloud_run.worker_service_uri
  pubsub_push_sa_email = module.iam.pubsub_push_sa_email
  api_sa_email         = module.iam.api_sa_email
  worker_sa_email      = module.iam.worker_sa_email
  worker_oidc_audience = local.worker_oidc_audience
  events_topic_id      = local.pubsub_topic_id

  depends_on = [
    module.project_services,
    module.iam,
    module.cloud_run,
  ]
}

# -----------------------------------------------------------------------------
# Module: Cloud Armor
# -----------------------------------------------------------------------------

module "cloud_armor" {
  source = "./modules/cloud-armor"

  project_id = var.project_id

  depends_on = [module.project_services]
}

# -----------------------------------------------------------------------------
# Module: Load Balancer & SSL Certificate
# -----------------------------------------------------------------------------

module "load_balancer" {
  source = "./modules/load-balancer"

  project_id            = var.project_id
  region                = var.region
  domain_name           = var.domain_name
  api_service_name      = module.cloud_run.api_service_name
  web_service_name      = module.cloud_run.web_service_name
  cloud_armor_policy_id = module.cloud_armor.policy_id

  depends_on = [
    module.project_services,
    module.cloud_run,
    module.cloud_armor,
  ]
}

# -----------------------------------------------------------------------------
# Module: Cloud Scheduler (Cleanup Sweeps)
# -----------------------------------------------------------------------------

module "scheduler" {
  source = "./modules/scheduler"

  project_id           = var.project_id
  region               = var.region
  worker_service_url   = module.cloud_run.worker_service_uri
  cleanup_sa_email     = module.iam.cleanup_sa_email
  worker_oidc_audience = local.worker_oidc_audience

  depends_on = [
    module.project_services,
    module.iam,
    module.cloud_run,
  ]
}

# -----------------------------------------------------------------------------
# Module: Cloud Monitoring & Alerts
# -----------------------------------------------------------------------------

module "monitoring" {
  source = "./modules/monitoring"

  project_id             = var.project_id
  project_number         = var.project_number
  billing_account_id     = var.billing_account_id
  incident_contact_email = var.incident_contact_email
  dlq_topic_name         = module.pubsub.dlq_topic_name

  depends_on = [
    module.project_services,
    module.pubsub,
  ]
}

# -----------------------------------------------------------------------------
# Module: Cloudflare DNS Record
# -----------------------------------------------------------------------------

module "cloudflare_dns" {
  source = "./modules/cloudflare-dns"

  enable_record      = var.enable_cloudflare_dns
  cloudflare_zone_id = var.cloudflare_zone_id
  record_name        = "staging-falseroute"
  lb_ip_address      = module.load_balancer.external_ip_address
  proxied            = false

  depends_on = [module.load_balancer]
}
