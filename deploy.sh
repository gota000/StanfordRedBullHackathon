#!/usr/bin/env bash
# Deploy Flappy Workout to Google Cloud Run.
# Prereqs: gcloud installed + `gcloud auth login` done + a project with billing enabled.
#
# Usage:
#   ./deploy.sh                      # uses current gcloud project, region us-central1
#   REGION=us-west1 ./deploy.sh
#   GEMINI_API_KEY=xxxx ./deploy.sh  # also wires the live Gemini challenge key
set -euo pipefail

SERVICE="${SERVICE:-flappy-workout}"
REGION="${REGION:-us-central1}"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"

if [ -z "${PROJECT:-}" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
fi

echo "Deploying '$SERVICE' to project '$PROJECT' in '$REGION'…"

# Single instance keeps the in-memory rooms + leaderboard coherent and ensures the
# phone/laptop WebSockets land on the same instance. --timeout 3600 allows long-lived WS.
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --timeout 3600 \
  --port 8080 \
  ${GEMINI_API_KEY:+--set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY"}

echo
echo "Done. Service URL:"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'
