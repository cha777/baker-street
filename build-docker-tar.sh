#!/usr/bin/env bash
set -euo pipefail

echo "1. Building linux/amd64 Docker image (baker-street-bot:latest)..."
docker build --platform linux/amd64 -t baker-street-bot:latest .

echo "2. Exporting Docker image to baker-street-bot-amd64.tar..."
docker save -o baker-street-bot-amd64.tar baker-street-bot:latest

echo "✅ Done! Image saved to: $(pwd)/baker-street-bot-amd64.tar"
ls -lh baker-street-bot-amd64.tar
