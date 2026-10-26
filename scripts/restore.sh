#!/usr/bin/env bash
#
# Restaura um dump gerado pelo backup.sh.
#
#   ./scripts/restore.sh <arquivo.dump[.gpg]> <URL_DESTINO> --sim
#
# ⚠ O destino é OBRIGATÓRIO e explícito, e `--sim` é obrigatório. Restaurar
# sobrescreve o banco inteiro — herdar a DATABASE_URL do ambiente por
# conveniência é como este tipo de script destrói produção.
#
# Rode isto de verdade, periodicamente. Backup que nunca foi restaurado é uma
# suposição, não uma garantia: só a restauração prova que o arquivo abre, que a
# versão do servidor aceita o formato e quanto tempo o procedimento leva —
# número que você precisa saber ANTES do dia em que precisar dele.

set -euo pipefail

ARQUIVO="${1:-}"
URL="${2:-}"
CONFIRMA="${3:-}"

if [[ -z "$ARQUIVO" || -z "$URL" ]]; then
  echo "uso: ./scripts/restore.sh <arquivo.dump[.gpg]> <URL_DESTINO> --sim" >&2
  exit 1
fi
[[ -f "$ARQUIVO" ]] || { echo "arquivo não encontrado: $ARQUIVO" >&2; exit 1; }

BANCO="$(echo "$URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
HOST="$(echo "$URL" | sed -E 's#.*://[^@]*@([^:/]+).*#\1#')"
# `?schema=public` é dialeto do Prisma e o libpq recusa.
URL_PG="${URL%%\?*}"

if [[ "$CONFIRMA" != "--sim" ]]; then
  echo ""
  echo "  Isto vai SOBRESCREVER o banco \"$BANCO\" em \"$HOST\"."
  echo "  Confirme repetindo com --sim no fim."
  echo ""
  exit 1
fi

command -v pg_restore >/dev/null 2>&1 || {
  echo "pg_restore não está no PATH." >&2
  echo "  Windows: export PATH=\"/c/Program Files/PostgreSQL/16/bin:\$PATH\"" >&2
  exit 1
}

TEMPORARIO=""
if [[ "$ARQUIVO" == *.gpg ]]; then
  command -v gpg >/dev/null 2>&1 || { echo "arquivo cifrado e gpg ausente." >&2; exit 1; }
  TEMPORARIO="$(mktemp)"
  echo "├─ decifrando"
  gpg --yes --batch --quiet --decrypt --output "$TEMPORARIO" "$ARQUIVO"
  ARQUIVO="$TEMPORARIO"
fi
# O arquivo em claro some mesmo se a restauração falhar no meio.
trap '[[ -n "$TEMPORARIO" ]] && rm -f "$TEMPORARIO"' EXIT

echo "├─ restaurando em \"$BANCO\" ($HOST)"
INICIO=$(date +%s)
# --clean --if-exists derruba os objetos antes de recriar, tornando o script
# repetível. --no-owner/--no-privileges casam com o que o backup gravou.
# `|| true`: pg_restore devolve status != 0 por AVISOS (extensão já existente,
# por exemplo). A prova de sucesso é a conferência abaixo, não o código de saída.
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$URL_PG" "$ARQUIVO" || true
DURACAO=$(( $(date +%s) - INICIO ))

echo "├─ conferindo o que chegou"
# As opções vêm ANTES da conexão: com a URL primeiro, o psql a trata como
# argumento posicional e IGNORA todas as flags seguintes (inclusive o -c), sem
# erro visível — só um aviso fácil de não ler.
psql -t -A -F' | ' -d "$URL_PG" -c "
  SELECT 'processos', count(*) FROM processos
  UNION ALL SELECT 'pessoas', count(*) FROM pessoas
  UNION ALL SELECT 'telefones', count(*) FROM telefones
  UNION ALL SELECT 'indices trigram', count(*) FROM pg_indexes WHERE indexdef ILIKE '%trgm%';"
# Literais em ASCII de propósito: com acento, a consulta passa pelo console do
# Windows e volta como byte inválido para UTF-8, derrubando a conferência logo
# depois de uma restauração bem-sucedida — o pior momento para um erro confuso.

echo "└─ restaurado em ${DURACAO}s. Compare os números acima com os da origem."
