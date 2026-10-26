-- ═══════════════════════════════════════════════════════════════════
--  O CATÁLOGO DEIXA DE SER SÓ FEDERAL
--  04/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas as deste repositório: `prisma migrate diff`
-- propõe derrubar os índices trigram da busca por nome.
--
-- ── POR QUE AGORA ──
--
-- O catálogo tinha os seis TRFs e mais nada, porque até aqui o produto só
-- consumia as planilhas de dívida consolidada da Justiça Federal. O arquivo de
-- PRÉ-PRECATÓRIOS de 03/09/2026 traz 1.169 oportunidades em 42 tribunais: 723
-- linhas de Justiça Estadual, 132 de Justiça do Trabalho e 314 de Federal.
--
-- A importação recusa qualquer sigla fora do catálogo (importacao.service.ts),
-- então 855 das 1.169 linhas seriam rejeitadas na porta. Estes 37 registros são
-- o que falta para elas passarem.
--
-- ── ISTO NÃO LIBERA A IMPORTAÇÃO SOZINHO ──
--
-- Cadastrar tribunal é condição necessária e não suficiente. Continuam faltando:
-- a coluna de fase, a TRAVA DE DISTRIBUIÇÃO (hoje `PROCESSO_DISTRIBUIVEL` filtra
-- só por organização interna e exclusão de titular — sem ela, importar é vender
-- na madrugada seguinte, sem ninguém decidir), a chave que separa requisitórios
-- irmãos, e o perfil de importação multi-tribunal.
--
-- Um tribunal cadastrado e sem perfil não importa nada; ele apenas passa a
-- existir para o seletor de lote e para o catálogo da carteira.
--
-- ── SOBRE `esfera` ──
--
-- A coluna existe desde a migration inicial e tem DEFAULT 'FEDERAL'. Por isso
-- ela é preenchida EXPLICITAMENTE aqui: omitir faria 37 tribunais estaduais e
-- trabalhistas nascerem marcados como federais, e nada reclamaria.
--
-- ── SOBRE `ufsJurisdicao` ──
--
-- Serve para ORDENAR o seletor de UF (lote.tsx: jurisdição primeiro, demais
-- depois), não para restringir busca — o próprio comentário de lá lembra que
-- "requerente do TRF5 morando em SP existe". Valor errado aqui é incômodo de
-- ordenação, não defeito de dado.
--
-- Nos TJs a jurisdição é a própria UF da sigla. Nos TRTs é por REGIÃO, e não se
-- deduz da sigla: TRT2 é São Paulo capital e TRT15 é o interior paulista — os
-- dois em SP. E TRT10 cobre DF e Tocantins; TRT11, Amazonas e Roraima; TRT14,
-- Rondônia e Acre.
--
-- ── IDEMPOTENTE ──
--
-- `ON CONFLICT ("sigla") DO NOTHING`: rodar de novo não duplica nem falha, e um
-- tribunal já cadastrado à mão no painel sobrevive com os dados que tiver.

INSERT INTO "tribunais" ("id","sigla","nome","esfera","ufsJurisdicao","editadoEm") VALUES
 -- ── Justiça Estadual (24) ──
 (gen_random_uuid(),'TJAL','Tribunal de Justiça de Alagoas','ESTADUAL',ARRAY['AL']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJAP','Tribunal de Justiça do Amapá','ESTADUAL',ARRAY['AP']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJBA','Tribunal de Justiça da Bahia','ESTADUAL',ARRAY['BA']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJCE','Tribunal de Justiça do Ceará','ESTADUAL',ARRAY['CE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJDFT','Tribunal de Justiça do Distrito Federal e dos Territórios','ESTADUAL',ARRAY['DF']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJES','Tribunal de Justiça do Espírito Santo','ESTADUAL',ARRAY['ES']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJGO','Tribunal de Justiça de Goiás','ESTADUAL',ARRAY['GO']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJMA','Tribunal de Justiça do Maranhão','ESTADUAL',ARRAY['MA']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJMG','Tribunal de Justiça de Minas Gerais','ESTADUAL',ARRAY['MG']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJMS','Tribunal de Justiça de Mato Grosso do Sul','ESTADUAL',ARRAY['MS']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJMT','Tribunal de Justiça de Mato Grosso','ESTADUAL',ARRAY['MT']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJPA','Tribunal de Justiça do Pará','ESTADUAL',ARRAY['PA']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJPB','Tribunal de Justiça da Paraíba','ESTADUAL',ARRAY['PB']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJPE','Tribunal de Justiça de Pernambuco','ESTADUAL',ARRAY['PE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJPI','Tribunal de Justiça do Piauí','ESTADUAL',ARRAY['PI']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJPR','Tribunal de Justiça do Paraná','ESTADUAL',ARRAY['PR']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJRJ','Tribunal de Justiça do Rio de Janeiro','ESTADUAL',ARRAY['RJ']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJRN','Tribunal de Justiça do Rio Grande do Norte','ESTADUAL',ARRAY['RN']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJRO','Tribunal de Justiça de Rondônia','ESTADUAL',ARRAY['RO']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJRR','Tribunal de Justiça de Roraima','ESTADUAL',ARRAY['RR']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJRS','Tribunal de Justiça do Rio Grande do Sul','ESTADUAL',ARRAY['RS']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJSC','Tribunal de Justiça de Santa Catarina','ESTADUAL',ARRAY['SC']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJSE','Tribunal de Justiça de Sergipe','ESTADUAL',ARRAY['SE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TJSP','Tribunal de Justiça de São Paulo','ESTADUAL',ARRAY['SP']::VARCHAR(2)[],now()),

 -- ── Justiça do Trabalho (13) ──
 -- A jurisdição é por REGIÃO. TRT2 (capital) e TRT15 (interior) dividem SP.
 (gen_random_uuid(),'TRT1','Tribunal Regional do Trabalho da 1ª Região','TRABALHISTA',ARRAY['RJ']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT2','Tribunal Regional do Trabalho da 2ª Região','TRABALHISTA',ARRAY['SP']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT3','Tribunal Regional do Trabalho da 3ª Região','TRABALHISTA',ARRAY['MG']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT4','Tribunal Regional do Trabalho da 4ª Região','TRABALHISTA',ARRAY['RS']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT9','Tribunal Regional do Trabalho da 9ª Região','TRABALHISTA',ARRAY['PR']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT10','Tribunal Regional do Trabalho da 10ª Região','TRABALHISTA',ARRAY['DF','TO']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT11','Tribunal Regional do Trabalho da 11ª Região','TRABALHISTA',ARRAY['AM','RR']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT14','Tribunal Regional do Trabalho da 14ª Região','TRABALHISTA',ARRAY['RO','AC']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT15','Tribunal Regional do Trabalho da 15ª Região','TRABALHISTA',ARRAY['SP']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT16','Tribunal Regional do Trabalho da 16ª Região','TRABALHISTA',ARRAY['MA']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT18','Tribunal Regional do Trabalho da 18ª Região','TRABALHISTA',ARRAY['GO']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT20','Tribunal Regional do Trabalho da 20ª Região','TRABALHISTA',ARRAY['SE']::VARCHAR(2)[],now()),
 (gen_random_uuid(),'TRT23','Tribunal Regional do Trabalho da 23ª Região','TRABALHISTA',ARRAY['MT']::VARCHAR(2)[],now())
ON CONFLICT ("sigla") DO NOTHING;
