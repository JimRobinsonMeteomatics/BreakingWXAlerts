#!/bin/zsh
# Launched by launchd (com.breawx.alerts). Loads .env then runs the server.
cd "$(dirname "$0")"
set -a; . ./.env; set +a
exec /usr/local/bin/node src/server.ts
