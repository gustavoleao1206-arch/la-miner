import { ImageResponse } from 'next/og';

import { SIMBOLO_OG_DATA_URI } from './simbolo-og';

/**
 * O cartão que aparece quando alguém cola o link no WhatsApp, no LinkedIn ou no
 * e-mail.
 *
 * A landing já declarava `og:title` e `og:description`, mas NÃO tinha imagem —
 * e link sem imagem vira uma tira de texto cinza no meio da conversa. Para um
 * produto que vai ser divulgado por indicação entre escritórios, o primeiro
 * contato com a marca é justamente esse cartão.
 *
 * Escopo `(site)`: vale para a landing e para as páginas legais, e NÃO para o
 * painel — que nem deve ser compartilhado.
 *
 * O CARTÃO é composto em código porque o formato importa — cliente de mensagem
 * recorta o que não estiver em 1200×630. Mas o SÍMBOLO é o arquivo real da
 * marca, lido do disco: esta versão do cartão mostrava só o nome em texto, e
 * cartão de indicação entre escritórios sem símbolo nenhum desperdiça
 * justamente o primeiro contato visual com a marca.
 *
 * A arte vem EMBUTIDA (`simbolo-og.ts`), e não lida do disco. O porquê está
 * documentado lá: o caminho relativo respondia 500, e a alternativa por
 * `readFileSync` passaria a depender de onde o bundle pousa em produção — uma
 * falha que ninguém veria, porque quem compartilha o link não é quem o abre.
 */
export const alt = 'Leão Amorim Miner: há valor enterrado em milhões de linhas de dados públicos';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function CartaoDeCompartilhamento() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#070B14',
          padding: 72,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={SIMBOLO_OG_DATA_URI} alt="" width={43} height={62} />
          <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, color: '#EAF0FB' }}>
            LEÃO AMORIM
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: 6,
              color: '#26D5EE',
            }}
          >
            MINER
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* A manchete da Jazida Digital — a mesma da landing, com o azul da marca na
              mesma palavra. Cartão que promete uma coisa e página que entrega
              outra queimam a confiança antes do clique. */}
          <div
            style={{
              display: 'flex',
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1.12,
              color: '#EAF0FB',
            }}
          >
            Há&nbsp;<span style={{ color: '#4F7CFF' }}>valor</span>&nbsp;enterrado em
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1.12,
              color: '#EAF0FB',
            }}
          >
            milhões de linhas de dados.
          </div>
          <div style={{ display: 'flex', marginTop: 22, fontSize: 26, color: '#909BBB' }}>
            250 créditos judiciais por mês, com o titular identificado e o contato conferido.
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 22, color: '#909BBB' }}>laminer.com.br</div>
      </div>
    ),
    size,
  );
}
