#!/usr/bin/env bash

set -Eeuo pipefail

JOB_NAME="falseroute-database-migrate"
API_SERVICE="falseroute-api"
API_SERVICE_ACCOUNT_SUFFIX="falseroute-api-sa"
DATABASE_SECRET="falseroute-api-database-url"
VPC_CONNECTOR="fr-staging-vpc-conn"

fail() {
  printf '[staging-migrations] ERROR: %s\n' "$1" >&2
  exit 1
}

command -v gcloud >/dev/null 2>&1 || fail "gcloud CLI is required. Install it and run 'gcloud auth login'."

ACTIVE_ACCOUNT="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null | head -n 1 || true)"
[[ -n "$ACTIVE_ACCOUNT" ]] || fail "No active gcloud account. Run 'gcloud auth login' first."

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] || fail "No active project. Run 'gcloud config set project PROJECT_ID'."

REGION="${GCP_REGION:-${REGION:-}}"
if [[ -z "$REGION" ]]; then
  REGION="$(gcloud run services list \
    --project="$PROJECT_ID" \
    --filter="metadata.name=$API_SERVICE" \
    --format='value(location)' 2>/dev/null | head -n 1 || true)"
fi
[[ -n "$REGION" ]] || fail "Could not determine the API region. Set GCP_REGION, for example: GCP_REGION=us-central1 pnpm staging:migrate"

API_IMAGE="$(gcloud run services describe "$API_SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
[[ -n "$API_IMAGE" ]] || fail "Could not determine the deployed API image for $API_SERVICE in $REGION."

printf '\n[staging-migrations] Account: %s\n' "$ACTIVE_ACCOUNT"
printf '[staging-migrations] Project: %s\n' "$PROJECT_ID"
printf '[staging-migrations] Region:  %s\n' "$REGION"
printf '[staging-migrations] Image:   %s\n' "$API_IMAGE"
printf '[staging-migrations] Database migrations will run in Cloud Run through the private VPC connector.\n\n'

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Apply the reviewed staging migrations now? Type 'yes' to continue: " confirmation
  [[ "$confirmation" == "yes" ]] || fail "Migration cancelled."
fi

printf '[staging-migrations] Deploying migration job...\n'
gcloud run jobs deploy "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$API_IMAGE" \
  --service-account="$API_SERVICE_ACCOUNT_SUFFIX@$PROJECT_ID.iam.gserviceaccount.com" \
  --command='node' \
  --args='node_modules/prisma/build/index.js,migrate,deploy,--schema=/app/prisma/schema.prisma' \
  --set-secrets="DATABASE_URL=$DATABASE_SECRET:latest" \
  --vpc-connector="$VPC_CONNECTOR" \
  --vpc-egress='private-ranges-only' \
  --tasks=1 \
  --max-retries=0 \
  --task-timeout=10m \
  --quiet

printf '[staging-migrations] Executing migration job and waiting for completion...\n'
gcloud run jobs execute "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --wait \
  --quiet

printf '\n[staging-migrations] Migration job completed successfully.\n'
printf '[staging-migrations] Recent executions:\n'
gcloud run jobs executions list \
  --job="$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --limit=3 \
  --format='table(name,createTime,completionTime)' \
  --quiet
