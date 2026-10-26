import type { PessoaEnriquecida, TelefoneEnriquecido } from '../../domain/enrichment-provider.port';

/**
 * Mapeia a resposta da consulta por CPF da Contactra (/v1/pessoas/cpf).
 *
 * Armadilhas que este mapper resolve:
 *  1. `telefones` NÃO é lista plana: vem como { fixos: [], moveis: [] }
 *  2. Datas vêm em DD/MM/AAAA — `new Date()` do JS interpreta errado
 *  3. `falecido` (não `obito`) é o campo de falecimento
 */

/** DD/MM/AAAA → Date. Retorna undefined se não casar o formato. */
export function dataBR(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, dia, mes, ano] = m;
  const d = new Date(Number(ano), Number(mes) - 1, Number(dia));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * ═══ O QUE NÃO CABE NA COLUNA NÃO PASSA DAQUI ═══
 *
 * Quatro colunas do schema têm limite duro e são alimentadas por texto que veio
 * de fora: `Telefone.ddd` VarChar(3), `Telefone.numero` VarChar(15),
 * `Endereco.uf` VarChar(2) e `Endereco.cep` VarChar(8). O mapper entregava o
 * valor do provedor cru para as quatro, sem conferir tamanho.
 *
 * Um valor grande demais não dá erro no mapper: ele viaja intacto até o
 * `INSERT`, onde o Postgres levanta 22001 ("value too long"). Isso acontecia
 * DENTRO da transação do enriquecimento — ou seja, depois de a consulta já ter
 * sido PAGA. Era o gatilho mais barato para o rollback que fazia o job ser
 * retentado e o provedor cobrado de novo.
 *
 * ── DESCARTAR, E NUNCA TRUNCAR ──
 *
 * Cortar um telefone de 20 dígitos em 15 não produz um telefone: produz um
 * número errado, que alguém vai ligar. É a mesma regra que a fonte dos
 * pré-precatórios já enuncia para o CPF — "documento errado ao lado de um nome é
 * pior que documento nenhum". Valor que não pode ser verdade sai fora; o resto
 * do registro continua.
 */

/** UF só existe com exatamente duas letras. Qualquer outra coisa não é UF. */
function ufValida(v: unknown): string | undefined {
  if (v == null) return undefined;
  const u = String(v).toUpperCase().replace(/[^A-Z]/g, '');
  return u.length === 2 ? u : undefined;
}

/** CEP brasileiro tem exatamente 8 dígitos — 7 ou 9 não é CEP incompleto, é outra coisa. */
function cepValido(v: unknown): string | undefined {
  if (v == null) return undefined;
  const d = String(v).replace(/\D/g, '');
  return d.length === 8 ? d : undefined;
}

/** DDD brasileiro tem exatamente 2 dígitos. Sem DDD o telefone ainda serve. */
function dddValido(v: string): string | undefined {
  return v.length === 2 ? v : undefined;
}

function telefonesDe(bloco: unknown, tipo: 'FIXO' | 'MOVEL'): TelefoneEnriquecido[] {
  if (!Array.isArray(bloco)) return [];
  return bloco
    .map((t: Record<string, unknown>) => {
      const bruto = String(t.numero ?? t.telefone ?? '').replace(/\D/g, '');
      const ddd = String(t.ddd ?? '').replace(/\D/g, '');
      // Alguns retornos trazem DDD embutido no número.
      const semDdd = !ddd && bruto.length > 9 ? bruto.slice(2) : bruto;
      return {
        ddd: dddValido(ddd) ?? (bruto.length > 9 ? bruto.slice(0, 2) : undefined),
        numero: semDdd,
        tipo,
        whatsapp: typeof t.whatsapp === 'boolean' ? t.whatsapp : undefined,
        /* O provedor manda um `score` de confiabilidade aqui. Ele não é mapeado
           de propósito: nada no sistema o lia, e o descarte na ENTRADA é o que
           faz a minimização valer — filtrar depois de gravar não minimiza nada. */
      };
    })
    /* Piso 8 porque telefone brasileiro sem DDD tem 8 ou 9 dígitos; teto 15
       porque é o que `Telefone.numero` comporta. O que sobra do teto é lixo do
       provedor (número concatenado, id no lugar do telefone) — e lixo cortado em
       15 dígitos continua sendo lixo, só que com cara de telefone. */
    .filter((t) => t.numero.length >= 8 && t.numero.length <= 15);
}

export function mapearRespostaContactra(bruto: unknown): PessoaEnriquecida | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const env = bruto as Record<string, any>;
  const r = env.resposta;
  if (!r || typeof r !== 'object') return null;

  const dc = (r.cadastro ?? {}) as Record<string, any>;

  // telefones: { fixos: [], moveis: [] } — e os "Extras", cadastrados à parte no provedor
  const telefones: TelefoneEnriquecido[] = [
    ...telefonesDe(r.telefones?.moveis, 'MOVEL'),
    ...telefonesDe(r.telefones?.fixos, 'FIXO'),
    ...telefonesDe(r.telefonesExtras?.moveis, 'MOVEL'),
    ...telefonesDe(r.telefonesExtras?.fixos, 'FIXO'),
  ];

  const emailsBrutos = [
    ...(Array.isArray(r.emails) ? r.emails : []),
    ...(Array.isArray(r.emailsExtras) ? r.emailsExtras : []),
  ];
  const emails = emailsBrutos
    .map((e: any) => ({
      endereco: String(typeof e === 'string' ? e : (e?.email ?? e?.endereco ?? ''))
        .toLowerCase()
        .trim(),
      /* Sem `score`, pela mesma razão do telefone acima. */
    }))
    .filter((e) => e.endereco.includes('@'));

  const enderecosBrutos = [
    ...(Array.isArray(r.enderecos) ? r.enderecos : []),
    ...(Array.isArray(r.enderecosExtras) ? r.enderecosExtras : []),
  ];
  const enderecos = enderecosBrutos.map((a: Record<string, any>) => ({
    // tipoLogradouro vem separado ("R") — juntar dá o endereço legível.
    logradouro: [a.tipoLogradouro, a.logradouro].filter(Boolean).join(' ').trim() || undefined,
    numero: a.numero != null ? String(a.numero) : undefined,
    complemento: a.complemento ?? undefined,
    bairro: a.bairro ?? undefined,
    cidade: a.cidade ?? undefined,
    uf: ufValida(a.uf),
    cep: cepValido(a.cep),
    tipo: a.qualidadeCep ?? undefined,
  }));

  const temAlgo =
    dc.nome || telefones.length > 0 || emails.length > 0 || enderecos.length > 0;
  if (!temAlgo) return null;

  return {
    nome: dc.nome ?? undefined,
    dataNascimento: dataBR(dc.dataNascimento),
    nomeMae: dc.nomeDaMae ?? undefined,
    situacaoCadastral: dc.situacaoCadastral ?? undefined,
    // Campo correto é falecido — "obito" não existe nesta API.
    obito: dc.falecido === true,
    telefones,
    emails,
    enderecos,
  };
}
