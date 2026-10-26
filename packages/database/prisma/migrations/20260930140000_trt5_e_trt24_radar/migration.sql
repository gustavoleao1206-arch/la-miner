-- ═══════════════════════════════════════════════════════════════════
--  TRT5 E TRT24: OS DOIS QUE BARRARAM OS RADARES DE 18/09 E 22/09
--  30/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas as deste repositório: `prisma migrate diff`
-- propõe derrubar os índices trigram da busca por nome.
--
-- ── POR QUE AGORA ──
--
-- Quatro arquivos novos do radar (18, 21, 22 e 30/09; 4.655 linhas). Dois deles
-- trazem siglas que o catálogo não tem, e a importação recusa a CARGA INTEIRA
-- quando isso acontece — a mesma recusa de 17/09, pelo mesmo motivo:
--
--   radar de 18/09 ...... TRT5 ×1   TRT24 ×1
--   radar de 22/09 ...... TRT5 ×2
--
-- São 4 linhas que seguram 2.180. E, como em 17/09, o tribunal cadastrado vale
-- para toda carga futura: descartar as linhas hoje seria repetir a recusa no
-- próximo radar que citar a Bahia ou Mato Grosso do Sul.
--
-- Com estes dois, a Justiça do Trabalho fica completa: as 24 regiões.
-- (Na estadual falta só o TJTO, que nenhum radar trouxe até hoje.)
--
-- ── SOBRE `ufsJurisdicao` ──
--
-- Serve para ORDENAR o seletor de UF, não para restringir busca. Nos TRTs é por
-- REGIÃO e não se deduz da sigla — por isso escrita à mão: TRT5 é a Bahia,
-- TRT24 é Mato Grosso do Sul. Os dois são de UF única.
--
-- ⚠ `esfera` é preenchida EXPLICITAMENTE. A coluna tem DEFAULT 'FEDERAL', e
-- omitir faria os dois nascerem marcados como federais sem nada reclamar.
--
-- ── IDEMPOTENTE ──
--
-- `ON CONFLICT ("sigla") DO NOTHING`: rodar de novo não duplica nem falha.

INSERT INTO "tribunais" ("id","sigla","nome","esfera","ufsJurisdicao","editadoEm") VALUES
 (gen_random_uuid(),'TRT5','Tribunal Regional do Trabalho da 5ª Região','TRABALHISTA',ARRAY['BA']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT24','Tribunal Regional do Trabalho da 24ª Região','TRABALHISTA',ARRAY['MS']::VARCHAR(2)[],now())
ON CONFLICT ("sigla") DO NOTHING;
