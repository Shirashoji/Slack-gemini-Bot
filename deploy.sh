#!/bin/bash
set -e

echo "Pushing files to Google Apps Script..."
clasp push

echo "Creating a new deployment..."
# You can customize the description for each deployment
clasp deploy --description "New version deployed from CLI"

echo "Deployment successful."
