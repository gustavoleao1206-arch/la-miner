-- ═══════════════════════════════════════════════════════════════════
--  A CONFERÊNCIA DO CPF PELO NOME
--  04/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas: o `migrate diff` derruba os índices trigram da
-- busca por nome.
--
-- ── O QUE ISTO RESOLVE ──
--
-- Nos pré-precatórios o CPF não vem de campo estruturado. A própria fonte
-- documenta: "NENHUMA fonte pública devolve documento em campo (…) o número é
-- extraído do texto do despacho e só entra depois de passar no dígito
-- verificador."
--
-- Dígito verificador válido prova que o número é BEM FORMADO, não que ele seja
-- daquele credor. A fonte reconhece o risco ao explicar que descarta o documento
-- quando há mais de um credor no polo ativo: "documento errado ao lado de um
-- nome é pior que documento nenhum".
--
-- O enriquecimento já resolvia isso de graça e jogava fora: a Contactra devolve
-- o nome de quem REALMENTE tem o CPF, e o processor recebia esse nome sem
-- usá-lo. Agora ele compara, e o veredito fica aqui.
--
-- ── O QUE NÃO ENTRA ──
--
-- O nome do provedor NÃO é guardado. Guardá-lo dobraria a superfície de dado
-- pessoal e daria à exclusão do titular mais um lugar para alcançar. O veredito
-- basta: é ele que a tela mostra e é ele que diz se a abordagem é segura.
--
-- ── ADITIVA, COM DEFAULT ──
--
-- Ao contrário de `Processo.fase`, aqui o default FICA. A diferença é o que a
-- ausência significa: fase ausente seria um palpite sobre o que o crédito É;
-- conferência ausente é a verdade — ninguém conferiu ainda. As ~5.954 pessoas
-- da base nascem em NAO_CONFERIDO, e vão para CONFERE ou DIVERGE no próximo
-- enriquecimento de cada uma.

CREATE TYPE "ConferenciaNome" AS ENUM ('NAO_CONFERIDO', 'CONFERE', 'DIVERGE');

ALTER TABLE "pessoas"
  ADD COLUMN "conferenciaNome" "ConferenciaNome" NOT NULL DEFAULT 'NAO_CONFERIDO';

-- Índice PARCIAL: a pergunta operacional é "quem diverge?", e divergentes são a
-- minoria por construção. Um índice sobre a coluna inteira gastaria espaço com
-- os NAO_CONFERIDO e os CONFERE, que ninguém procura por essa via.
CREATE INDEX "pessoas_conferencia_divergente_idx"
  ON "pessoas"("conferenciaNome")
  WHERE "conferenciaNome" = 'DIVERGE';
