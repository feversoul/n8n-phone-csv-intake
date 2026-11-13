#!/bin/sh
# test/stack.sh up|down|logs   the test stack by hand
cd "$(dirname "$0")/.."
compose="docker compose --env-file test/test.env -f docker-compose.yml -f test/docker-compose.yml -p csvintake-test"
case "$1" in
  up) $compose up -d ;;
  down) $compose down -v ;;
  logs) $compose logs --tail "${TAIL:-40}" "${2:-n8n}" ;;
esac
