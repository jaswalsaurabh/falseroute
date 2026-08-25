#!/usr/bin/env bash

# Safe lifecycle helper for the optional Google Cloud staging stack.
#
# This script does not build images and does not bypass the GitHub Actions
# infrastructure approval gate. `pause`/`resume` are reversible gcloud
# operations; `destroy-all` is an explicit, destructive Terraform operation.

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly TERRAFORM_DIR="${TERRAFORM_DIR:-infrastructure/terraform}"
project_default="${GCP_PROJECT_ID:-}"
region_default="${GCP_REGION:-${RUN_REGION:-}}"
if command -v gcloud >/dev/null 2>&1; then
  [[ -n "$project_default" ]] || project_default="$(gcloud config get-value project 2>/dev/null || true)"
  if [[ -z "$region_default" ]]; then
    region_default="$(gcloud config get-value run/region 2>/dev/null || true)"
  fi
  if [[ -z "$region_default" ]]; then
    region_default="$(gcloud config get-value compute/region 2>/dev/null || true)"
  fi
fi
readonly PROJECT_ID="$project_default"
readonly REGION="$region_default"
readonly SQL_INSTANCE="${SQL_INSTANCE:-falseroute-staging-db}"
readonly API_SERVICE="${API_SERVICE:-falseroute-api}"
readonly WORKER_SERVICE="${WORKER_SERVICE:-falseroute-worker}"
readonly WEB_SERVICE="${WEB_SERVICE:-falseroute-web}"
readonly VPC_CONNECTOR="${VPC_CONNECTOR:-fr-staging-vpc-conn}"

usage() {
  cat <<'EOF'
Usage:
  staging-lifecycle.sh status
  staging-lifecycle.sh pause
  staging-lifecycle.sh down-hybrid
  staging-lifecycle.sh resume
  staging-lifecycle.sh up API_DIGEST WORKER_DIGEST WEB_DIGEST
  staging-lifecycle.sh destroy-all

Required for status/pause/resume:
  GCP_REGION (GCP_PROJECT_ID is read from gcloud config when omitted)

Required for up:
  GitHub CLI authentication and three linux/amd64 image digests in the
  form sha256:<64 lowercase hexadecimal characters>.

Notes:
  - `up` dispatches deploy-infrastructure-staging.yml. The GitHub Actions
    staging-infrastructure environment approval remains required.
  - `pause` keeps resources and data, but changes Cloud Run scaling and stops
    Cloud SQL. Terraform will restore its configured values on a later apply.
  - `down-hybrid` performs `pause`, then deletes only the non-pausable
    load-balancer, Cloud Armor, and Serverless VPC Access resources. It keeps
    Cloud SQL, the VPC/private-services network, Pub/Sub, secrets, IAM, and
    Artifact Registry intact.
  - After `down-hybrid`, run `up` and approve Terraform before using `resume`.
  - `destroy-all` deletes all resources in the main Terraform stack, including
    the database and Artifact Registry contents. It does not delete the
    separately bootstrapped Terraform state bucket.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_project_context() {
  [[ -n "$PROJECT_ID" ]] || { printf 'Set GCP_PROJECT_ID first.\n' >&2; exit 1; }
  [[ -n "$REGION" ]] || { printf 'Set GCP_REGION first.\n' >&2; exit 1; }
  require_command gcloud
}

validate_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    printf 'Invalid image digest: %s\nExpected sha256:<64 lowercase hex characters>.\n' "$1" >&2
    exit 1
  }
}

status() {
  require_project_context
  printf '%s\n' 'Cloud Run services:'
  for service in "$API_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
    if gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" --format='value(status.conditions[0].status)' 2>/dev/null; then
      printf '  %s: present\n' "$service"
    else
      printf '  %s: absent\n' "$service"
    fi
  done

  printf '%s\n' 'Cloud SQL:'
  gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" \
    --format='value(state,settings.activationPolicy)' 2>/dev/null || printf '  absent\n'

  printf '%s\n' 'VPC connector:'
  gcloud compute networks vpc-access connectors describe "$VPC_CONNECTOR" \
    --project="$PROJECT_ID" --region="$REGION" --format='value(state)' 2>/dev/null || printf '  absent\n'
}

pause() {
  require_project_context
  printf '%s\n' 'Pausing Cloud SQL and scaling Cloud Run to zero...'
  if gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud sql instances patch "$SQL_INSTANCE" --project="$PROJECT_ID" --activation-policy=NEVER
  else
    printf 'Cloud SQL instance already absent: %s\n' "$SQL_INSTANCE"
  fi
  for service in "$API_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
    if gcloud run services describe "$service" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
      gcloud run services update "$service" --project="$PROJECT_ID" --region="$REGION" \
        --min=0 --max=1 --quiet
    else
      printf 'Cloud Run service already absent: %s\n' "$service"
    fi
  done
  printf '%s\n' 'Paused. VPC connector and load balancer remain present and may still incur charges.'
}

delete_if_present() {
  local description="$1"
  shift
  local -a describe_command=("$@")
  local -a delete_command=("$@")
  local index
  for index in "${!delete_command[@]}"; do
    if [[ "${delete_command[$index]}" == 'describe' ]]; then
      delete_command[$index]='delete'
      break
    fi
  done
  if "${describe_command[@]}" >/dev/null 2>&1; then
    printf 'Deleting %s...\n' "$description"
    "${delete_command[@]}" --quiet
  else
    printf '%s already absent.\n' "$description"
  fi
}

delete_nonpausable_resources() {
  # Delete in dependency order: forwarding rules -> proxies -> URL maps ->
  # backends/NEGs/certificate -> Armor policy and address -> VPC connector.
  delete_if_present 'global HTTPS forwarding rule' \
    gcloud compute forwarding-rules describe falseroute-staging-https-fwd-rule --global --project="$PROJECT_ID"
  delete_if_present 'global HTTP forwarding rule' \
    gcloud compute forwarding-rules describe falseroute-staging-http-fwd-rule --global --project="$PROJECT_ID"
  delete_if_present 'target HTTPS proxy' \
    gcloud compute target-https-proxies describe falseroute-staging-https-proxy --global --project="$PROJECT_ID"
  delete_if_present 'target HTTP proxy' \
    gcloud compute target-http-proxies describe falseroute-staging-http-proxy --global --project="$PROJECT_ID"
  delete_if_present 'HTTPS URL map' \
    gcloud compute url-maps describe falseroute-staging-url-map --global --project="$PROJECT_ID"
  delete_if_present 'HTTP redirect URL map' \
    gcloud compute url-maps describe falseroute-staging-http-redirect --global --project="$PROJECT_ID"
  delete_if_present 'API backend service' \
    gcloud compute backend-services describe falseroute-api-backend --global --project="$PROJECT_ID"
  delete_if_present 'Web backend service' \
    gcloud compute backend-services describe falseroute-web-backend --global --project="$PROJECT_ID"
  delete_if_present 'regional API serverless NEG' \
    gcloud compute network-endpoint-groups describe falseroute-api-neg --region="$REGION" --project="$PROJECT_ID"
  delete_if_present 'regional Web serverless NEG' \
    gcloud compute network-endpoint-groups describe falseroute-web-neg --region="$REGION" --project="$PROJECT_ID"
  delete_if_present 'managed SSL certificate' \
    gcloud compute ssl-certificates describe falseroute-staging-cert --global --project="$PROJECT_ID"
  delete_if_present 'Cloud Armor policy' \
    gcloud compute security-policies describe falseroute-staging-armor --project="$PROJECT_ID"
  delete_if_present 'global load-balancer address' \
    gcloud compute addresses describe falseroute-staging-lb-ip --global --project="$PROJECT_ID"
  delete_if_present 'Serverless VPC Access connector' \
    gcloud compute networks vpc-access connectors describe "$VPC_CONNECTOR" --region="$REGION" --project="$PROJECT_ID"
}

down_hybrid() {
  require_project_context
  printf '%s\n' 'WARNING: this pauses runtime services and deletes the load balancer, Cloud Armor, static IP, and VPC connector.' >&2
  read -r -p 'Type DOWN-HYBRID to continue: ' confirmation
  [[ "$confirmation" == 'DOWN-HYBRID' ]] || { printf 'Cancelled.\n'; exit 1; }
  printf '%s\n' 'Entering hybrid shutdown mode.'
  pause
  delete_nonpausable_resources
  printf '%s\n' 'Hybrid shutdown complete.'
  printf '%s\n' 'Preserved: Cloud SQL data, VPC/private-services network, Pub/Sub, secrets, IAM, Artifact Registry, and Terraform state.'
  printf '%s\n' 'Run the GitHub infrastructure workflow to recreate deleted resources before live deployment.'
}

resume() {
  require_project_context
  printf '%s\n' 'Starting Cloud SQL and restoring configured Cloud Run minimums...'
  gcloud sql instances patch "$SQL_INSTANCE" --project="$PROJECT_ID" --activation-policy=ALWAYS
  gcloud run services update "$API_SERVICE" --project="$PROJECT_ID" --region="$REGION" --min=1 --max=1 --quiet
  gcloud run services update "$WORKER_SERVICE" --project="$PROJECT_ID" --region="$REGION" --min=1 --max=1 --quiet
  gcloud run services update "$WEB_SERVICE" --project="$PROJECT_ID" --region="$REGION" --min=0 --max=2 --quiet
  printf '%s\n' 'Resumed. Wait for Cloud SQL readiness before running migrations.'
}

up() {
  [[ "$#" -eq 3 ]] || { usage >&2; exit 2; }
  for digest in "$@"; do validate_digest "$digest"; done
  require_command gh
  gh workflow run deploy-infrastructure-staging.yml --ref main \
    -f "api_image_digest=$1" \
    -f "worker_image_digest=$2" \
    -f "web_image_digest=$3"
  printf '%s\n' 'Infrastructure workflow dispatched. Approve the staging-infrastructure environment in GitHub Actions.'
}

destroy_all() {
  require_command terraform
  [[ -d "$TERRAFORM_DIR" ]] || { printf 'Terraform directory not found: %s\n' "$TERRAFORM_DIR" >&2; exit 1; }
  printf '%s\n' 'WARNING: this deletes the complete Terraform-managed staging stack, including Cloud SQL data and Artifact Registry images.' >&2
  read -r -p 'Type DESTROY-STAGING to continue: ' confirmation
  [[ "$confirmation" == 'DESTROY-STAGING' ]] || { printf 'Cancelled.\n'; exit 1; }
  terraform -chdir="$TERRAFORM_DIR" destroy -input=false
}

main() {
  local action="${1:-}"
  case "$action" in
    status) require_command gcloud; status ;;
    pause) pause ;;
    down-hybrid) down_hybrid ;;
    resume) resume ;;
    up) shift; up "$@" ;;
    destroy-all) destroy_all ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
