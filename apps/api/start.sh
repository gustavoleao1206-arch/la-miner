#!/usr/bin/env bash
# Carrega o .env da RAIZ (fonte única) e sobe a API.
# Evita o modo de falha em que o dotenv resolve pelo cwd e pega o arquivo errado.
set -a; source "$(dirname "$0")/../../.env"; set +a
exec node "$(dirname "$0")/dist/main.js"
