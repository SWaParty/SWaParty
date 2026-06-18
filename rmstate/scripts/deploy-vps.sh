#!/usr/bin/env sh
set -eu

cd /opt/swaparty-room/rmstate

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and fill secrets first." >&2
  exit 1
fi

docker compose up -d --build
docker compose ps
