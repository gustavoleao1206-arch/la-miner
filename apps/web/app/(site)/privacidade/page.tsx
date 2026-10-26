import type { Metadata } from 'next';

import { PaginaLegal, Secao } from '@/components/site/pagina-legal';
import { EMPRESA } from '@/lib/dados-empresa';

export const metadata: Metadata = {
  title: 'Política de Privacidade',
  description:
    'Como a Leão Amorim Tecnologia trata dados pessoais no Leão Amorim Miner, ' +
    'incluindo os dados de titulares de precatórios que vêm de fontes judiciais públicas.',
  alternates: { canonical: '/privacidade' },
};

/**
 * ── A PARTE DIFÍCIL DESTE DOCUMENTO ──
 *
 * O produto trata dados de DUAS populações com relações muito diferentes
 * conosco: os clientes (que assinam e concordam) e os TITULARES DE PRECATÓRIOS
 * (que nunca ouviram falar da gente). Uma política que só falasse da primeira
 * estaria calando justamente a parte que a LGPD mais cobra — e o comprador
 * deste produto é advogado, treinado para notar exatamente esse silêncio.
 *
 * Por isso a seção 3 existe e é explícita sobre origem, base legal e direitos
 * de quem não é cliente.
 */
export default function PrivacidadePage() {
  return (
    <PaginaLegal
      titulo="Política de Privacidade"
      resumo={
        'Este documento explica quais dados pessoais o Leão Amorim Miner trata, de onde ' +
        'eles vêm, com que fundamento, com quem são compartilhados e como exercer seus direitos.'
      }
    >
      <Secao n={1} titulo="Quem é o controlador">
        <p>
          {EMPRESA.razaoSocial}, CNPJ {EMPRESA.cnpj}, com sede em {EMPRESA.endereco} (&ldquo;Leão
          Amorim&rdquo;), é a controladora dos dados pessoais descritos nas seções 2 e 3.
        </p>
        <p>
          Contato para assuntos de privacidade e proteção de dados:{' '}
          <a href={`mailto:${EMPRESA.email}`} className="text-marca-ciano hover:underline">
            {EMPRESA.email}
          </a>
          .
        </p>
      </Secao>

      <Secao n={2} titulo="Dados de clientes e usuários do sistema">
        <p>Ao contratar e usar o Miner, tratamos:</p>
        <ul>
          <li>
            <strong>Cadastro:</strong> nome do escritório, CNPJ ou CPF, nome do responsável,
            e-mail e telefone.
          </li>
          <li>
            <strong>Acesso:</strong> e-mail, senha (armazenada apenas como hash Argon2id, nunca
            em texto) e, quando ativada, a configuração de autenticação em dois fatores.
          </li>
          <li>
            <strong>Registros de uso:</strong> data e hora de acessos, endereço IP, navegador e
            ações relevantes no sistema (importações, consultas, exportações). Servem para
            auditoria e segurança.
          </li>
          <li>
            <strong>Financeiro:</strong> faturas, datas e status de pagamento. Os dados do meio
            de pagamento (cartão, PIX, boleto) são tratados diretamente pelo gateway: nós não
            recebemos nem armazenamos número de cartão.
          </li>
        </ul>
        <p>
          <strong>Bases legais:</strong> execução do contrato (art. 7º, V da LGPD) para cadastro,
          acesso e cobrança; cumprimento de obrigação legal (art. 7º, II) para registros fiscais e
          contábeis; e legítimo interesse (art. 7º, IX) para os registros de segurança e auditoria.
        </p>
      </Secao>

      <Secao n={3} titulo="Dados de titulares de precatórios">
        <p>
          O Miner reúne informações sobre precatórios e outros créditos judiciais — de tribunais
          federais, estaduais e trabalhistas — e sobre as pessoas indicadas como
          seus titulares. <strong>Essas pessoas não são nossas clientes</strong> e, na maior parte
          dos casos, não têm relação conosco. Por isso esta seção é escrita separadamente.
        </p>
        <p>
          <strong>Quais dados:</strong> nome, CPF ou CNPJ, número do processo e do precatório,
          tribunal, entidade devedora, exercício orçamentário e valores. Quando disponível, dados
          de contato (telefone e e-mail) obtidos junto a provedores de enriquecimento cadastral.
        </p>
        <p>
          <strong>De onde vêm:</strong> de sistemas e publicações de tribunais federais,
          estaduais e trabalhistas, de acesso público, e de provedores de dados cadastrais
          contratados por nós.
        </p>
        <p>
          <strong>Com que fundamento:</strong> legítimo interesse (art. 7º, IX da LGPD) na
          organização de informações de acesso público para viabilizar a atuação de advogados e
          escritórios junto a titulares de precatórios. Dados tornados manifestamente públicos pelo
          próprio titular ou por determinação legal observam o art. 7º, §4º.
        </p>
        <p>
          <strong>O que não fazemos:</strong> não tratamos dados sensíveis (art. 5º, II da LGPD),
          não realizamos decisões automatizadas que afetem interesses do titular e não vendemos
          bancos de dados a terceiros fora da relação de assinatura descrita nos Termos de Uso.
        </p>
        <p>
          <strong>Quando o cliente vira controlador:</strong> a partir do momento em que um
          escritório assinante usa esses dados para prospectar, negociar ou contratar, ele passa a
          tratar dados pessoais por conta própria e responde por esse tratamento, inclusive pelo
          respeito às regras de contato e publicidade da sua profissão.
        </p>
      </Secao>

      <Secao n={4} titulo="Com quem compartilhamos">
        <p>
          Não vendemos dados pessoais. Compartilhamos apenas com operadores necessários para o
          serviço funcionar:
        </p>
        <ul>
          <li>
            <strong>Render</strong>: hospedagem da aplicação e do banco de dados.
          </li>
          <li>
            <strong>Cloudflare</strong>: DNS e proteção de rede.
          </li>
          <li>
            <strong>Asaas</strong>: emissão e processamento de cobranças.
          </li>
          <li>
            <strong>Resend</strong>: envio de e-mails transacionais (confirmação de cadastro,
            redefinição de senha).
          </li>
          <li>
            <strong>Provedores de enriquecimento cadastral</strong>: consulta de dados de contato
            associados a CPF/CNPJ.
          </li>
        </ul>
        <p>
          Também podemos compartilhar dados para cumprir ordem judicial, requisição de autoridade
          competente ou obrigação legal.
        </p>
        <p>
          <strong>Transferência internacional:</strong> parte da infraestrutura de hospedagem e de
          envio de e-mail está fora do Brasil. Nesses casos a transferência se dá para execução do
          contrato e com fornecedores que adotam cláusulas e medidas de segurança compatíveis com o
          art. 33 da LGPD.
        </p>
      </Secao>

      <Secao n={5} titulo="Por quanto tempo guardamos">
        <p>
          Dados de cadastro e uso: enquanto durar a assinatura. Encerrada a relação, a conta pode
          ser excluída ou anonimizada: os dados pessoais são removidos e permanecem apenas os
          registros de faturamento exigidos pela legislação fiscal, pelo prazo legal aplicável.
        </p>
        <p>
          Registros de acesso (data, hora, endereço IP e identificação do navegador em cada login
          e ação sensível): mantidos por 180 dias, prazo mínimo do art. 15 do Marco Civil da
          Internet. Ao fim desse prazo, o endereço IP e a identificação do navegador são removidos
          automaticamente, e o registro do evento permanece sem eles. Na trilha de consultas, o
          endereço IP já é gravado truncado (sem o último bloco) e segue a mesma remoção. Sessões
          encerradas são apagadas 30 dias após expirarem. Os registros técnicos de requisição não
          guardam endereço IP nem identificação do navegador.
        </p>
        <p>
          Dados de precatórios e de seus titulares: mantidos enquanto forem úteis à finalidade
          descrita na seção 3, ou até pedido de oposição ou eliminação atendido nos termos da lei.
        </p>
      </Secao>

      <Secao n={6} titulo="Seus direitos">
        <p>
          A LGPD garante a você, cliente ou titular de precatório, o direito de confirmar a
          existência de tratamento, acessar seus dados, corrigir dados incompletos ou desatualizados,
          solicitar anonimização, bloqueio ou eliminação de dados desnecessários, pedir portabilidade,
          obter informação sobre compartilhamento, revogar consentimento quando ele for a base legal,
          e <strong>opor-se a tratamento fundado em legítimo interesse</strong>.
        </p>
        <p>
          Para exercer qualquer um deles, escreva para{' '}
          <a href={`mailto:${EMPRESA.email}`} className="text-marca-ciano hover:underline">
            {EMPRESA.email}
          </a>
          . Responderemos no prazo legal. Podemos solicitar informações adicionais para confirmar
          sua identidade antes de atender: é uma proteção sua, não um obstáculo.
        </p>
      </Secao>

      <Secao n={7} titulo="Segurança">
        <p>
          Adotamos medidas técnicas e administrativas para proteger os dados, entre elas: tráfego
          cifrado (HTTPS), senhas armazenadas apenas como hash Argon2id, autenticação em dois
          fatores disponível, controle de acesso por papel, sessão única por pessoa, encerramento
          automático de sessões ociosas e trilha de auditoria das ações relevantes.
        </p>
        <p>
          Nenhum sistema é infalível. Em caso de incidente de segurança com risco relevante,
          comunicaremos os titulares afetados e a ANPD, na forma do art. 48 da LGPD.
        </p>
      </Secao>

      <Secao n={8} titulo="Cookies">
        <p id="cookies">
          Usamos apenas cookies necessários ao funcionamento: o que mantém sua sessão autenticada e
          os que garantem segurança da navegação. Não usamos cookies de publicidade nem de
          rastreamento de terceiros para perfilamento. Por serem estritamente necessários, esses
          cookies não dependem de consentimento (Guia Orientativo de Cookies da ANPD); o aviso
          exibido na primeira visita é informativo, e a sua dispensa fica registrada apenas no seu
          navegador.
        </p>
        <p>
          O vídeo de apresentação do produto é hospedado no YouTube e só é carregado depois que
          você clica para assisti-lo, no modo de privacidade ampliada (youtube-nocookie). Até esse
          clique, nenhuma conexão com o Google é feita a partir desta página. Ao assistir, aplicam-se
          as condições de privacidade do YouTube.
        </p>
        <p>
          Se um dia passarmos a usar cookies de medição ou de terceiros, esta seção será atualizada
          e o aviso voltará a ser exibido para que você decida, por categoria, o que aceita.
        </p>
      </Secao>

      <Secao n={9} titulo="Mudanças nesta política">
        <p>
          Podemos atualizar este documento. Quando a mudança for relevante, avisaremos por e-mail ou
          dentro do sistema antes de ela passar a valer. A data de vigência no topo indica a versão
          em uso.
        </p>
      </Secao>
    </PaginaLegal>
  );
}
