-- ═══════════════════════════════════════════════════════════════════
--  O PERFIL DE PRÉ-PRECATÓRIOS — o primeiro sem tribunal
--  04/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas as deste repositório.
--
-- `tribunalId` NULO é o que liga o modo multi-tribunal: o tribunal passa a vir
-- da coluna "Tribunal", linha a linha. É o primeiro perfil assim, e por isso ele
-- só é alcançável quando o operador o escolhe explicitamente — nenhum lote leva
-- até ele.
--
-- ── A ABA É DECLARADA, E ISSO NÃO É DETALHE ──
--
-- Nenhum dos 6 perfis anteriores declara `aba`, e com o campo nulo o leitor pega
-- A PRIMEIRA aba do arquivo, em silêncio. O arquivo de pré-precatórios tem duas:
-- "Oportunidades" (os dados) e "Como ler" (a documentação da procedência).
--
-- Hoje "Oportunidades" é a primeira e daria certo por sorte. Uma exportação que
-- invertesse a ordem faria a importação ler a aba de instruções: nenhuma coluna
-- casaria, e o operador veria "não encontrei a coluna cpf" sem entender por quê.
-- Declarar custa uma palavra.
--
-- ── SOBRE OS CAMPOS QUE NÃO ESTÃO AQUI ──
--
-- `valor` (o apurado) NÃO é mapeado, de propósito. A coluna da planilha é "Valor
-- extraído", e a própria fonte documenta: "NENHUMA fonte pública tem campo de
-- valor. Todo número foi extraído do texto (…) é palpite — pode ser honorário,
-- custas ou valor da causa." Ela vai para `valorIndicativo`, coluna separada que
-- não entra nos agregados que o cliente usa para decidir.
--
-- `originario` e `requisitorio` também não: o arquivo não tem essas colunas. O
-- número CNJ do processo é o único identificador, e ele vai para `processo`.
--
-- "Descrição da fase" é alias de `fase` junto com "Fase". O leitor devolve o
-- primeiro alias COM CONTEÚDO, e "Fase" (o código 1–4) vem primeiro — o tradutor
-- aceita as duas formas, então tanto faz qual chegar.
--
-- ── COLUNAS OBRIGATÓRIAS ──
--
-- `cpf`, `processo`, `tribunal` e `fase`. As duas últimas são novas nesta lista e
-- são o que o modo multi-tribunal não tem como suprir: sem tribunal o processo
-- não tem onde ser gravado, e sem fase ele seria vendido como coisa que não é.
-- Faltando qualquer uma, a importação falha ALTO, antes de escrever.

INSERT INTO "perfis_importacao"
  ("id","tribunalId","nome","mapaColunas","colunasObrigatorias","aba","editadoEm")
VALUES (
  gen_random_uuid(),
  NULL,
  'Pré-precatórios (multi-tribunal)',
  '{
    "cpf":["cpf do credor","cpf"],
    "nome":["credor","nome do credor","nome"],
    "processo":["processo","numero do processo","número do processo"],
    "tribunal":["tribunal","sigla do tribunal","tribunal de origem"],
    "fase":["fase","descricao da fase","descrição da fase"],
    "entidade":["ente devedor","entidade devedora","entidade"],
    "vara":["orgao julgador","órgão julgador","juizo de origem","juízo de origem","vara"],
    "valorIndicativo":["valor extraido","valor extraído","valor indicativo"]
  }'::jsonb,
  ARRAY['cpf','processo','tribunal','fase']::TEXT[],
  'Oportunidades',
  now()
)
ON CONFLICT DO NOTHING;
