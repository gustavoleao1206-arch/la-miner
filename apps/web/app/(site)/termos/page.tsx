import type { Metadata } from 'next';
import Link from 'next/link';

import { PaginaLegal, Secao } from '@/components/site/pagina-legal';
import { EMPRESA } from '@/lib/dados-empresa';

export const metadata: Metadata = {
  title: 'Termos de Uso',
  description:
    'Condições de contratação e uso do Leão Amorim Miner: plano, entrega, pagamento, ' +
    'cancelamento e responsabilidades.',
  alternates: { canonical: '/termos' },
};

/**
 * Os termos descrevem o que o SISTEMA realmente faz, e os números vêm do
 * comportamento medido em código: 250 por ciclo, acúmulo, sem repetição para o
 * mesmo cliente, sem exclusividade entre clientes, vencimento em 10 dias e
 * carência de 5. Termo que promete diferente do que o software entrega é o
 * documento que o cliente usa contra você.
 */
export default function TermosPage() {
  return (
    <PaginaLegal
      titulo="Termos de Uso"
      resumo={
        'Condições da assinatura do Leão Amorim Miner. Ao criar uma conta, você declara ter ' +
        'lido e aceito estes termos e a Política de Privacidade.'
      }
    >
      <Secao n={1} titulo="Quem contrata e quem fornece">
        <p>
          O serviço é fornecido por {EMPRESA.razaoSocial}, CNPJ {EMPRESA.cnpj}, com sede em{' '}
          {EMPRESA.endereco}. Contratante é a pessoa jurídica ou o profissional identificado no
          cadastro, responsável pelas informações que fornece.
        </p>
        <p>
          O Miner é uma ferramenta destinada a escritórios de advocacia e profissionais que atuam
          com precatórios. Não é um serviço ao consumidor final.
        </p>
      </Secao>

      <Secao n={2} titulo="O que é entregue">
        <p>
          A assinatura dá acesso a uma carteira de créditos judiciais com titular identificado e
          dados de contato conferidos, entregue em ciclos mensais. A carteira reúne{' '}
          <strong>precatórios já expedidos</strong> e <strong>pré-precatórios</strong> — o mesmo
          crédito num estágio anterior, ainda sem precatório expedido —, de tribunais federais,
          estaduais e trabalhistas. O estágio de cada processo é informado no sistema:
        </p>
        <ul>
          <li>
            <strong>250 processos novos por mês</strong>, conforme o plano contratado.
          </li>
          <li>
            <strong>Acumulativos:</strong> o que foi entregue permanece na sua carteira. No segundo
            mês você tem 500, no terceiro 750, e assim por diante enquanto a assinatura estiver
            ativa.
          </li>
          <li>
            <strong>Sem repetição:</strong> um processo já entregue a você não é entregue de novo.
          </li>
          <li>
            <strong>Sem exclusividade:</strong> o mesmo processo pode ser entregue a outros
            assinantes. A Leão Amorim não promete exclusividade sobre nenhum precatório, e qualquer
            afirmação em contrário só vale por escrito e assinada.
          </li>
        </ul>
        <p>
          A entrega depende de haver processos ainda não entregues a você na base. Se a base se
          esgotar para a sua carteira, avisaremos e o ciclo seguinte não será cobrado até que haja
          entrega.
        </p>
      </Secao>

      <Secao n={3} titulo="Origem dos dados e o que você assume ao usá-los">
        <p>
          Os dados vêm de sistemas e publicações dos Tribunais Regionais Federais, de acesso
          público, complementados por provedores de enriquecimento cadastral. Trabalhamos para que
          estejam corretos e atualizados, mas{' '}
          <strong>não garantimos exatidão, atualidade ou completude</strong>: a fonte é externa e
          muda sem aviso.
        </p>
        <p>
          Conferir a informação antes de agir sobre ela é responsabilidade sua. Isso vale
          especialmente para valores, situação processual e dados de contato.
        </p>
        <p>
          Ao usar os dados para prospectar ou contratar, você passa a tratá-los por conta própria e
          responde por esse tratamento perante a LGPD e perante as regras da sua profissão,
          inclusive as do Código de Ética e Disciplina da OAB sobre captação de clientela e
          publicidade. A ferramenta organiza informação; o uso que se faz dela é seu.
        </p>
      </Secao>

      <Secao n={4} titulo="Conta, acesso e segurança">
        <p>
          O acesso é pessoal e intransferível. Cada plano permite um número definido de perfis, e o
          sistema mantém <strong>uma sessão ativa por pessoa</strong>: entrar em outro dispositivo
          encerra a sessão anterior. Compartilhar credenciais é descumprimento destes termos.
        </p>
        <p>
          Você é responsável por manter suas credenciais em sigilo e por tudo que for feito com
          elas. Suspeitando de uso indevido, troque a senha e avise-nos.
        </p>
        <p>
          Para criar a conta é necessário confirmar o e-mail informado. É essa confirmação que
          impede que um endereço digitado errado gere uma conta inacessível, e um pagamento que
          precisa ser desfeito.
        </p>
      </Secao>

      <Secao n={5} titulo="Preço, cobrança e inadimplência">
        <p>
          O valor e a periodicidade são os exibidos na contratação. A cobrança é emitida por
          gateway de pagamento, com vencimento em 10 dias, e aceita os meios habilitados na conta
          (PIX, boleto e cartão).
        </p>
        <p>
          <strong>O acesso é liberado após a confirmação do pagamento.</strong> No plano anual, o
          pagamento cobre 12 meses de assinatura, e a entrega dos processos continua sendo mensal.
        </p>
        <p>
          Vencida a fatura, há carência de 5 dias. Persistindo a inadimplência, o acesso é suspenso
          até a regularização. A suspensão não apaga a carteira já entregue: ela volta a ficar
          disponível quando o pagamento é confirmado.
        </p>
        <p>
          Reajustes podem ocorrer a cada 12 meses e serão comunicados com pelo menos 30 dias de
          antecedência. Você pode cancelar antes de o novo valor passar a valer.
        </p>
      </Secao>

      <Secao n={6} titulo="Prazo, cancelamento e reembolso">
        <p>
          O plano mensal não tem fidelidade: pode ser cancelado a qualquer momento e vale até o fim
          do ciclo já pago, sem devolução proporcional.
        </p>
        <p>
          O plano anual é contratado por 12 meses. O cancelamento antes do término não gera
          devolução dos meses restantes, salvo nos casos de arrependimento e de descumprimento
          descritos abaixo.
        </p>
        <p>
          <strong>Arrependimento:</strong> em até 7 dias da contratação, e desde que não tenha
          havido entrega de carteira, o valor pago é devolvido integralmente.
        </p>
        <p>
          Podemos encerrar a assinatura, com devolução proporcional do período pago e não usufruído,
          se o serviço for descontinuado ou se houver descumprimento destes termos por nossa parte.
        </p>
      </Secao>

      <Secao n={7} titulo="Uso permitido">
        <p>Ao usar o Miner, você concorda em não:</p>
        <ul>
          <li>
            revender, sublicenciar, redistribuir ou disponibilizar a base a terceiros que não sejam
            assinantes;
          </li>
          <li>
            extrair a base de forma automatizada, por raspagem, engenharia reversa ou uso indevido
            de credenciais;
          </li>
          <li>compartilhar acesso com quem não integra o seu escritório;</li>
          <li>
            usar os dados para finalidade ilícita, para assédio, ou em desacordo com as regras da
            sua profissão.
          </li>
        </ul>
        <p>
          O descumprimento autoriza a suspensão imediata do acesso, sem prejuízo das medidas
          cabíveis.
        </p>
      </Secao>

      <Secao n={8} titulo="Disponibilidade">
        <p>
          Trabalhamos para manter o sistema disponível, mas não oferecemos, nestes termos, garantia
          contratual de disponibilidade (SLA). Pode haver interrupções para manutenção, atualização
          ou por falha de fornecedores de infraestrutura. Interrupções relevantes e programadas serão
          comunicadas com antecedência sempre que possível.
        </p>
      </Secao>

      <Secao n={9} titulo="Propriedade intelectual">
        <p>
          O software, a marca, a interface e a organização da base são da Leão Amorim. A assinatura
          concede direito de uso durante a vigência, não transfere propriedade e não autoriza cópia
          ou derivação.
        </p>
        <p>
          Os dados processuais em si são de origem pública; o que é nosso é a coleta, o tratamento,
          a identificação de titulares e a forma como tudo isso é organizado e entregue.
        </p>
      </Secao>

      <Secao n={10} titulo="Limitação de responsabilidade">
        <p>
          A Leão Amorim não responde por decisões de negócio tomadas com base nos dados, por
          resultados de prospecção, por perda de oportunidade, nem por danos indiretos ou lucros
          cessantes.
        </p>
        <p>
          Nossa responsabilidade, quando existir, fica limitada ao valor pago pelo contratante nos
          12 meses anteriores ao fato. Esta limitação não se aplica a dolo ou às hipóteses em que a
          lei a afaste.
        </p>
      </Secao>

      <Secao n={11} titulo="Privacidade">
        <p>
          O tratamento de dados pessoais está descrito na{' '}
          <Link href="/privacidade" className="text-marca-ciano hover:underline">
            Política de Privacidade
          </Link>
          , que integra estes termos.
        </p>
      </Secao>

      <Secao n={12} titulo="Mudanças e foro">
        <p>
          Podemos alterar estes termos. Mudanças relevantes serão comunicadas com pelo menos 30 dias
          de antecedência, e o uso após a vigência significa concordância. Discordando, você pode
          cancelar antes.
        </p>
        <p>
          Aplica-se a lei brasileira. Fica eleito o foro da comarca de {EMPRESA.cidadeForo}, com
          renúncia a qualquer outro.
        </p>
      </Secao>
    </PaginaLegal>
  );
}
