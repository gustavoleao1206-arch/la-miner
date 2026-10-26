-- ═══════════════════════════════════════════════════════════════════
--  OS ONZE QUE FALTAVAM PARA O RADAR ENTRAR
--  17/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas as deste repositório: `prisma migrate diff`
-- propõe derrubar os índices trigram da busca por nome.
--
-- ── POR QUE AGORA ──
--
-- Os dois arquivos do radar (16/09, 2.039 linhas; 17/09, 1.087) trazem 11
-- siglas que o catálogo não tem. A importação as recusa na porta, e recusa a
-- CARGA INTEIRA — "para não entrar pela metade", que é a decisão certa: 25
-- linhas órfãs valem menos que 3.114 entrando com uma parte faltando sem aviso.
--
-- São 25 linhas somadas, e é por isso que elas merecem uma migration em vez de
-- serem descartadas: o tribunal cadastrado vale para toda carga futura, e o
-- radar publica todo dia. Descartar hoje seria repetir a recusa amanhã.
--
--   TRT7  4    TJAC  3    TRT12 3    TRT8  3    TJAM  2    TRT17 2
--   TRT22 2    TRT19 2    TRT21 2    TRT6  1    TRT13 1
--
-- ── SOBRE `ufsJurisdicao` ──
--
-- Serve para ORDENAR o seletor de UF, não para restringir busca. Nos TJs é a
-- própria UF da sigla. Nos TRTs é por REGIÃO e não se deduz da sigla — daí cada
-- uma estar escrita à mão aqui: TRT8 cobre Pará E Amapá; as demais desta leva
-- são de UF única.
--
-- ⚠ `esfera` é preenchida EXPLICITAMENTE. A coluna tem DEFAULT 'FEDERAL', e
-- omitir faria estes onze nascerem marcados como federais sem nada reclamar.
--
-- ── IDEMPOTENTE ──
--
-- `ON CONFLICT ("sigla") DO NOTHING`: rodar de novo não duplica nem falha.

INSERT INTO "tribunais" ("id","sigla","nome","esfera","ufsJurisdicao","editadoEm") VALUES
 -- ── Justiça Estadual (2) ──
 (gen_random_uuid(),'TJAC','Tribunal de Justiça do Acre','ESTADUAL',ARRAY['AC']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJAM','Tribunal de Justiça do Amazonas','ESTADUAL',ARRAY['AM']::VARCHAR(2)[],now()),
 -- ── Justiça do Trabalho (9) ──
 (gen_random_uuid(),'TRT6','Tribunal Regional do Trabalho da 6ª Região','TRABALHISTA',ARRAY['PE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT7','Tribunal Regional do Trabalho da 7ª Região','TRABALHISTA',ARRAY['CE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT8','Tribunal Regional do Trabalho da 8ª Região','TRABALHISTA',ARRAY['PA','AP']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT12','Tribunal Regional do Trabalho da 12ª Região','TRABALHISTA',ARRAY['SC']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT13','Tribunal Regional do Trabalho da 13ª Região','TRABALHISTA',ARRAY['PB']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT17','Tribunal Regional do Trabalho da 17ª Região','TRABALHISTA',ARRAY['ES']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT19','Tribunal Regional do Trabalho da 19ª Região','TRABALHISTA',ARRAY['AL']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT21','Tribunal Regional do Trabalho da 21ª Região','TRABALHISTA',ARRAY['RN']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT22','Tribunal Regional do Trabalho da 22ª Região','TRABALHISTA',ARRAY['PI']::VARCHAR(2)[],now())
ON CONFLICT ("sigla") DO NOTHING;
