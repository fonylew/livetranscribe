#!/usr/bin/env bash
# ==============================================================================
# LiveTranscribe Deployment Script (Cloud Run + GCS + Firestore | Local Mode)
#
# Usage:
#   1. Cloud Run Deployment (creates GCS bucket + Firestore DB + deploys Cloud Run):
#      ./deploy.sh --project=my-gcp-project [--region=asia-southeast1] [--bucket=my-srt-bucket]
#
#   2. Dry-Run Preview (prints exact gcloud commands without executing):
#      ./deploy.sh --project=my-gcp-project --dry-run
#
#   3. Local Deployment (runs locally on 0.0.0.0:3000 without Firestore):
#      ./deploy.sh --local
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# 1. Load .env if present (without overriding existing environment variables)
if [[ -f ".env" ]]; then
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line="$(echo "${raw_line}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    line="${line#export }"
    key="${line%%=*}"
    val="${line#*=}"
    # Strip surrounding quotes if present
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"
    if [[ -n "${key}" && -z "${!key:-}" ]]; then
      export "${key}=${val}"
    fi
  done < ".env"
fi

# 2. Default Configuration
MODE="cloud"
DRY_RUN="false"
PROJECT_ID="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}"
REGION="${GCP_REGION:-asia-southeast1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-livetranscribe}"
GCS_BUCKET="${GCS_BUCKET:-}"
GCS_PREFIX="${GCS_PREFIX:-livetranscribe/sessions}"
FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
FIRESTORE_COLLECTION="${FIRESTORE_COLLECTION:-livetranscribe_sessions}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-}"
LOCAL_HOST="${HOST:-0.0.0.0}"
LOCAL_PORT="${PORT:-3000}"

print_help() {
  cat <<EOF
Usage: ./deploy.sh [OPTIONS]

Modes:
  --cloud                         Deploy to Google Cloud Run, create GCS Bucket & Firestore DB (default)
  --local, local                  Run locally on ${LOCAL_HOST}:${LOCAL_PORT} with local .SRT storage (no Firestore required)
  --github, github                Deploy static ./public app to GitHub Pages (gh-pages branch + main)

Options (Cloud Mode):
  --project=PROJECT_ID            Google Cloud Project ID (or set GCP_PROJECT_ID in .env)
  --region=REGION                 Cloud Run & GCS Region (default: asia-southeast1)
  --service=SERVICE_NAME          Cloud Run service name (default: livetranscribe)
  --bucket=BUCKET_NAME            GCS Bucket for .SRT files (default: <PROJECT_ID>-livetranscribe-srt)
  --firestore-location=LOCATION   Firestore location (default: same as --region)
  --firestore-database=DB_ID      Firestore database ID (default: (default))
  --dry-run                       Print gcloud commands without executing them
  -h, --help                      Show this help message
EOF
}

# 3. Parse CLI Arguments
for arg in "$@"; do
  case "${arg}" in
    --local|local)
      MODE="local"
      ;;
    --github|github)
      MODE="github"
      ;;
    --cloud|cloud)
      MODE="cloud"
      ;;
    --dry-run)
      DRY_RUN="true"
      ;;
    --project=*)
      PROJECT_ID="${arg#*=}"
      ;;
    --region=*)
      REGION="${arg#*=}"
      ;;
    --service=*)
      SERVICE_NAME="${arg#*=}"
      ;;
    --bucket=*)
      GCS_BUCKET="${arg#*=}"
      ;;
    --firestore-location=*)
      FIRESTORE_LOCATION="${arg#*=}"
      ;;
    --firestore-database=*)
      FIRESTORE_DATABASE="${arg#*=}"
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      print_help
      exit 1
      ;;
  esac
done

# ==============================================================================
# GitHub Pages Deployment Mode (Pushes ./public to origin/gh-pages)
# ==============================================================================
if [[ "${MODE}" == "github" ]]; then
  echo "=================================================================="
  echo " Deploying LiveTranscribe (./public) to GitHub Pages (gh-pages)"
  echo "=================================================================="
  TMP_GH_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_GH_DIR}"' EXIT

  cp -R public/. "${TMP_GH_DIR}/"
  touch "${TMP_GH_DIR}/.nojekyll"

  REMOTE_URL="$(git config --get remote.origin.url)"
  if [[ -z "${REMOTE_URL}" ]]; then
    echo "Error: No git remote 'origin' configured." >&2
    exit 1
  fi

  (
    cd "${TMP_GH_DIR}"
    git init -q
    git checkout -q -b gh-pages
    git add -A
    git commit -q -m "Deploy LiveTranscribe static site to GitHub Pages"
    if [[ "${DRY_RUN}" == "true" ]]; then
      echo "+ git push --force ${REMOTE_URL} gh-pages:gh-pages"
    else
      git push --force "${REMOTE_URL}" gh-pages:gh-pages
    fi
  )

  echo "=================================================================="
  echo " GitHub Pages branch 'gh-pages' pushed to ${REMOTE_URL}!"
  echo " URL: https://fonylew.github.io/livetranscribe/"
  echo "=================================================================="
  exit 0
fi

# ==============================================================================
# Local Deployment Mode (No Firestore Required)
# ==============================================================================
if [[ "${MODE}" == "local" ]]; then
  echo "=================================================================="
  echo " Starting LiveTranscribe in LOCAL Mode (No Firestore Required)"
  echo " • Host / Port:       ${LOCAL_HOST}:${LOCAL_PORT}"
  echo " • Local SRT Dir:     ${DATA_DIR:-./data/sessions}"
  echo " • .env API Key:      $([[ -n "${GEMINI_API_KEY:-}" ]] && echo "Configured" || echo "Not set (enter in UI Settings)")"
  echo " • GCS Bucket Sync:   ${GCS_BUCKET:-Disabled (local disk only)}"
  echo " • Firestore Sync:    Disabled (local mode)"
  echo "=================================================================="
  export ENABLE_FIRESTORE="false"
  export HOST="${LOCAL_HOST}"
  export PORT="${LOCAL_PORT}"
  exec node server.js
fi

# ==============================================================================
# Cloud Run Deployment Mode (Cloud Run + GCS Bucket + Firestore)
# ==============================================================================
if [[ -z "${PROJECT_ID}" ]]; then
  if command -v gcloud >/dev/null 2>&1; then
    PROJECT_ID="$(gcloud config get-value project --quiet 2>/dev/null || true)"
  fi
fi

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Error: GCP Project ID is required for Cloud deployment." >&2
  echo "Pass --project=YOUR_PROJECT_ID or set GCP_PROJECT_ID in .env" >&2
  exit 1
fi

# Strip any gs:// prefix if provided
GCS_BUCKET="${GCS_BUCKET#gs://}"
GCS_BUCKET="${GCS_BUCKET%/}"
if [[ -z "${GCS_BUCKET}" ]]; then
  GCS_BUCKET="${PROJECT_ID}-livetranscribe-srt"
fi

if [[ -z "${FIRESTORE_LOCATION}" ]]; then
  FIRESTORE_LOCATION="${REGION}"
fi

echo "=================================================================="
echo " LiveTranscribe — Google Cloud Deployment"
echo " • Project ID:          ${PROJECT_ID}"
echo " • Region:              ${REGION}"
echo " • Cloud Run Service:   ${SERVICE_NAME}"
echo " • GCS Bucket (.SRT):   gs://${GCS_BUCKET}"
echo " • Firestore Database:  ${FIRESTORE_DATABASE} (${FIRESTORE_LOCATION})"
echo " • Firestore Coll.:     ${FIRESTORE_COLLECTION}"
echo " • .env GEMINI_API_KEY: $([[ -n "${GEMINI_API_KEY:-}" ]] && echo "Included from .env" || echo "Not set in .env (users can input in UI)")"
echo " • Dry Run:             ${DRY_RUN}"
echo "=================================================================="

run_cmd() {
  echo "+ $*"
  if [[ "${DRY_RUN}" != "true" ]]; then
    "$@"
  fi
}

# 1. Create Google Cloud Storage Bucket for .SRT files (if it doesn't exist)
echo ""
echo "[1/3] Checking / Creating Google Cloud Storage bucket gs://${GCS_BUCKET}..."
if [[ "${DRY_RUN}" == "true" ]]; then
  run_cmd gcloud storage buckets describe "gs://${GCS_BUCKET}" \
    --project="${PROJECT_ID}" \
    --format="json(name)" \
    --quiet
  run_cmd gcloud storage buckets create "gs://${GCS_BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --quiet
else
  if gcloud storage buckets describe "gs://${GCS_BUCKET}" \
    --project="${PROJECT_ID}" \
    --format="json(name)" \
    --quiet >/dev/null 2>&1; then
    echo "      Bucket gs://${GCS_BUCKET} already exists."
  else
    run_cmd gcloud storage buckets create "gs://${GCS_BUCKET}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --uniform-bucket-level-access \
      --public-access-prevention \
      --quiet
    echo "      Created bucket gs://${GCS_BUCKET}."
  fi
fi

# 2. Create Google Cloud Firestore Database (Cloud Deployment Only)
echo ""
echo "[2/3] Checking / Creating Google Cloud Firestore database '${FIRESTORE_DATABASE}'..."
if [[ "${DRY_RUN}" == "true" ]]; then
  run_cmd gcloud firestore databases describe \
    --database="${FIRESTORE_DATABASE}" \
    --project="${PROJECT_ID}" \
    --format="json(name)" \
    --quiet
  run_cmd gcloud firestore databases create \
    --database="${FIRESTORE_DATABASE}" \
    --location="${FIRESTORE_LOCATION}" \
    --type=firestore-native \
    --project="${PROJECT_ID}" \
    --quiet
else
  if gcloud firestore databases describe \
    --database="${FIRESTORE_DATABASE}" \
    --project="${PROJECT_ID}" \
    --format="json(name)" \
    --quiet >/dev/null 2>&1; then
    echo "      Firestore database '${FIRESTORE_DATABASE}' already exists."
  else
    run_cmd gcloud firestore databases create \
      --database="${FIRESTORE_DATABASE}" \
      --location="${FIRESTORE_LOCATION}" \
      --type=firestore-native \
      --project="${PROJECT_ID}" \
      --quiet
    echo "      Created Firestore database '${FIRESTORE_DATABASE}'."
  fi
fi

# 3. Deploy Service to Google Cloud Run
echo ""
echo "[3/3] Deploying ${SERVICE_NAME} to Google Cloud Run..."

ENV_VARS="NODE_ENV=production,ENABLE_FIRESTORE=true,GCP_PROJECT_ID=${PROJECT_ID},GCS_BUCKET=${GCS_BUCKET},GCS_PREFIX=${GCS_PREFIX},FIRESTORE_DATABASE=${FIRESTORE_DATABASE},FIRESTORE_COLLECTION=${FIRESTORE_COLLECTION}"
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  ENV_VARS="${ENV_VARS},GEMINI_API_KEY=${GEMINI_API_KEY}"
fi

run_cmd gcloud run deploy "${SERVICE_NAME}" \
  --source=. \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --allow-unauthenticated \
  --session-affinity \
  --set-env-vars="${ENV_VARS}" \
  --quiet

echo ""
echo "=================================================================="
echo " Deployment Complete!"
if [[ "${DRY_RUN}" != "true" ]]; then
  SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)" --quiet 2>/dev/null || true)"
  if [[ -n "${SERVICE_URL}" ]]; then
    echo " • Operator URL:   ${SERVICE_URL}/"
    echo " • OBS View URL:   ${SERVICE_URL}/?view=display"
  fi
fi
echo "=================================================================="
