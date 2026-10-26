#!/usr/bin/env bash
#
# Backup do banco em formato custom (-Fc): comprimido, restaurável seletivamente
# e independente da versão do servidor.
#
# Contexto: até a auditoria, o documento de arquitetura prometia "scripts/ # deploy,
# backup, manutenção" e a pasta estava vazia. Os únicos dumps existentes eram
# manuais, de duas semanas atrás, não cifrados e nunca restaurados.
#
#   ./scripts/backup.sh                     # usa DATABASE_URL do .env
#   ./scripts/backup.sh "postgresql://..."  # ou uma URL explícita
#
# Cifra o arquivo quando BACKUP_GPG_RECIPIENT estiver definido. Um dump com CPF,
# telefone e endereço de milhares de pessoas em claro num bucket é um vazamento
# esperando acontecer — se a chave existe, o arquivo em claro é apagado.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINO="${BACKUP_DIR:-$RAIZ/backups}"
RETENCAO_DIAS="${BACKUP_RETENCAO_DIAS:-30}"

URL="${1:-${DATABASE_URL:-}}"
if [[ -z "$URL" && -f "$RAIZ/.env" ]]; then
  # LÊ a linha, não faz `source`.
  # `source .env` EXECUTA o arquivo: qualquer valor com espaço, cifrão ou
  # parêntese vira comando. Aconteceu na primeira execução deste script — uma
  # linha com caminho do Windows foi interpretada como chamada de programa. Além
  # de frágil, é uma porta de execução de código a partir de um arquivo de
  # configuração.
  URL="$(grep -E '^[[:space:]]*DATABASE_URL[[:space:]]*=' "$RAIZ/.env" \
        | head -n1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^"//; s/"[[:space:]]*$//')"
fi
[[ -z "$URL" ]] && { echo "DATABASE_URL não definida e nenhuma URL passada." >&2; exit 1; }

# O `?schema=public` é dialeto do Prisma; o libpq recusa o parâmetro. Os
# utilitários do Postgres recebem a URL sem a query string.
URL_PG="${URL%%\?*}"

command -v pg_dump >/dev/null 2>&1 || {
  echo "pg_dump não está no PATH." >&2
  echo "  Windows: export PATH=\"/c/Program Files/PostgreSQL/16/bin:\$PATH\"" >&2
  exit 1
}

mkdir -p "$DESTINO"
CARIMBO="$(date +%Y%m%d-%H%M%S)"
ARQUIVO="$DESTINO/miner-$CARIMBO.dump"

echo "├─ gerando $ARQUIVO"
INICIO=$(date +%s)
# --no-owner/--no-privileges: o dump restaura em qualquer banco, sem depender de
# os mesmos papéis existirem no destino — que é justamente o caso de uma
# restauração de emergência num servidor novo.
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$ARQUIVO" "$URL_PG"
DURACAO=$(( $(date +%s) - INICIO ))

TAMANHO="$(du -h "$ARQUIVO" | cut -f1)"
echo "├─ ok: $TAMANHO em ${DURACAO}s"

if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  echo "├─ cifrando para $BACKUP_GPG_RECIPIENT"
  gpg --yes --batch --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$ARQUIVO"
  rm -f "$ARQUIVO"          # o arquivo em claro NÃO fica no disco
  ARQUIVO="$ARQUIVO.gpg"
  echo "├─ cifrado: $ARQUIVO"
else
  echo "├─ ⚠ SEM cifra (BACKUP_GPG_RECIPIENT não definida)."
  echo "│    Este arquivo tem os dados pessoais de milhares de titulares."
fi

# A retenção é parte do backup: guardar tudo para sempre é acumular
# responsabilidade sobre dado pessoal que já não serve para restaurar nada.
if [[ "$RETENCAO_DIAS" -gt 0 ]]; then
  APAGADOS=$(find "$DESTINO" -name 'miner-*.dump*' -type f -mtime "+$RETENCAO_DIAS" -print -delete | wc -l)
  [[ "$APAGADOS" -gt 0 ]] && echo "├─ retenção: $APAGADOS arquivo(s) com mais de ${RETENCAO_DIAS}d removido(s)"
fi

echo "└─ pronto. TESTE a restauração: ./scripts/restore.sh $ARQUIVO <URL_DESTINO> --sim"
