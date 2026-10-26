import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

/** Espelha o enum PrioridadeProcesso do Prisma. */
export enum Prioridade {
  BAIXA = 'BAIXA',
  NORMAL = 'NORMAL',
  ALTA = 'ALTA',
  URGENTE = 'URGENTE',
}

/** Espelha o enum EstagioCrm do Prisma. */
export enum Estagio {
  NOVO = 'NOVO',
  EM_CONTATO = 'EM_CONTATO',
  PROPOSTA = 'PROPOSTA',
  FECHADO = 'FECHADO',
  PERDIDO = 'PERDIDO',
}

export enum Canal {
  TELEFONE = 'TELEFONE',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  PRESENCIAL = 'PRESENCIAL',
  OUTRO = 'OUTRO',
}

export enum Resultado {
  ATENDEU = 'ATENDEU',
  NAO_ATENDEU = 'NAO_ATENDEU',
  NUMERO_ERRADO = 'NUMERO_ERRADO',
  RECADO = 'RECADO',
  RECUSOU = 'RECUSOU',
}

export class DefinirEstagioDto {
  @ApiProperty({ enum: Estagio, description: 'Onde o processo está no funil comercial' })
  @IsEnum(Estagio, { message: 'Estágio inválido.' })
  estagio!: Estagio;

  /**
   * Só para PERDIDO. Livre porque o motivo real varia mais do que qualquer
   * enum aguentaria — e engessá-lo faria todo mundo escolher "Outro", que é
   * exatamente o dado que não serve para nada.
   */
  @ApiPropertyOptional({ description: 'Por que se perdeu (só vale para PERDIDO)', maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  motivoPerda?: string;
}

/**
 * Uma tentativa de contato.
 *
 * `resultado` é OBRIGATÓRIO e `canal` tem padrão: registrar que se ligou sem
 * dizer no que deu produziria exatamente o dado que não responde nada — e a
 * pergunta que este registro existe para responder é "quantas tentativas até
 * uma proposta".
 */
export class RegistrarContatoDto {
  @ApiPropertyOptional({ enum: Canal, default: Canal.TELEFONE })
  @IsOptional()
  @IsEnum(Canal, { message: 'Canal inválido.' })
  canal?: Canal;

  @ApiProperty({ enum: Resultado })
  @IsEnum(Resultado, { message: 'Resultado inválido.' })
  resultado!: Resultado;

  @ApiPropertyOptional({ description: 'O que ficou combinado', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  observacao?: string;
}

/**
 * Ação em massa sobre a fila de trabalho.
 *
 * Todos os campos de mudança são opcionais, e ao menos um tem de vir — o
 * serviço recusa um lote que não pede alteração nenhuma. `responsavelId: null`
 * REMOVE o responsável; ausente não mexe. São coisas diferentes, e um DTO que
 * não as distinguisse tornaria "tirar o dono de 40 processos" impossível de
 * expressar.
 */
export class AcaoEmLoteDto {
  @ApiProperty({ description: 'Processos selecionados na fila', type: [String] })
  @IsArray()
  @ArrayMaxSize(500, { message: 'A ação em massa aceita até 500 processos por vez.' })
  @IsUUID('4', { each: true, message: 'Id de processo inválido.' })
  processoIds!: string[];

  @ApiPropertyOptional({ enum: Estagio })
  @IsOptional()
  @IsEnum(Estagio)
  estagio?: Estagio;

  /**
   * OPCIONAL, e não obrigatório com `estagio: PERDIDO`.
   *
   * Não por preguiça: a API e o site sobem em serviços separados, e um campo
   * obrigatório novo derrubaria toda ação em massa de "perdido" durante a janela
   * entre os dois deploys. Vale como decisão do dono torná-lo obrigatório depois
   * — mas aí a exigência nasce com os dois lados já no ar.
   */
  @ApiPropertyOptional({ description: 'Por que se perdeu (só vale para PERDIDO)', maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  motivoPerda?: string;

  @ApiPropertyOptional({ enum: Prioridade })
  @IsOptional()
  @IsEnum(Prioridade)
  prioridade?: Prioridade;

  @ApiPropertyOptional({ description: 'UUID, ou null para remover o responsável' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4', { message: 'Responsável inválido.' })
  responsavelId?: string | null;

  /** ACRESCENTA etiquetas, nunca substitui — ver a nota no serviço. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true, message: 'Etiqueta inválida.' })
  etiquetaIds?: string[];
}

/**
 * Texto de anotação.
 *
 * O teto de 5.000 caracteres não é estético: `texto` é TEXT sem limite no
 * Postgres, e sem trava aqui um POST de alguns megabytes entraria no banco e
 * voltaria em toda abertura da página do processo.
 */
export class CriarAnotacaoDto {
  @ApiProperty({ description: 'Conteúdo da anotação', maxLength: 5000 })
  @IsString()
  @Length(1, 5000, { message: 'A anotação precisa ter entre 1 e 5000 caracteres.' })
  texto!: string;

  @ApiPropertyOptional({ description: 'Fixa a anotação no topo da lista' })
  @IsOptional()
  @IsBoolean()
  fixada?: boolean;
}

export class EditarAnotacaoDto {
  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @Length(1, 5000, { message: 'A anotação precisa ter entre 1 e 5000 caracteres.' })
  texto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fixada?: boolean;
}

export class DefinirPrioridadeDto {
  @ApiProperty({ enum: Prioridade })
  @IsEnum(Prioridade, { message: 'Prioridade inválida.' })
  prioridade!: Prioridade;
}

export class DefinirResponsavelDto {
  @ApiProperty({
    description: 'Id do usuário responsável. `null` remove o responsável.',
    nullable: true,
  })
  /* Ausente e null são coisas DIFERENTES aqui, e `IsOptional` trataria as duas
     como a mesma: ele pula a validação tanto para undefined quanto para null.
     `ValidateIf` só dispensa o null explícito — o gesto de "tirar o
     responsável". Campo omitido cai no IsUUID e é recusado, que é o certo: um
     bug de serialização no front mandando `{}` esvaziaria a atribuição em
     silêncio se passasse. */
  @ValidateIf((o: DefinirResponsavelDto) => o.responsavelId !== null)
  @IsUUID('4', { message: 'Informe um usuário válido ou null.' })
  responsavelId!: string | null;
}

/**
 * Substitui o conjunto INTEIRO de etiquetas do processo.
 *
 * PUT com a lista completa, e não POST/DELETE por etiqueta: a tela edita um
 * conjunto de uma vez, e duas requisições concorrentes de add/remove deixariam
 * o processo num estado que nenhum dos dois operadores pediu. Aqui a última
 * escrita vence por inteiro — previsível de explicar e de depurar.
 */
export class DefinirEtiquetasDto {
  @ApiProperty({ description: 'Ids das etiquetas', type: [String] })
  @IsArray()
  @ArrayMaxSize(20, { message: 'No máximo 20 etiquetas por processo.' })
  @IsUUID('4', { each: true, message: 'Id de etiqueta inválido.' })
  etiquetaIds!: string[];
}

/** Espelha o enum TipoTarefa do Prisma. */
export enum TipoTarefa {
  TAREFA = 'TAREFA',
  FOLLOW_UP = 'FOLLOW_UP',
}

/**
 * `prazo` chega como "AAAA-MM-DD", NUNCA como ISO com hora.
 *
 * A coluna é DATE. Se o front mandasse um ISO completo, o fuso dele decidiria
 * o dia gravado: um "2026-07-25T00:00:00-03:00" enviado do Brasil viraria 25/07,
 * mas o mesmo gesto num cliente em UTC+2 gravaria 24/07. Prazo de petição não
 * pode depender de onde o advogado estava. O regex fecha a porta na entrada.
 */
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export class CriarTarefaDto {
  @ApiProperty({ maxLength: 300 })
  @IsString()
  @Length(1, 300, { message: 'A tarefa precisa ter entre 1 e 300 caracteres.' })
  titulo!: string;

  @ApiPropertyOptional({ enum: TipoTarefa, default: TipoTarefa.TAREFA })
  @IsOptional()
  @IsEnum(TipoTarefa, { message: 'Tipo de tarefa inválido.' })
  tipo?: TipoTarefa;

  @ApiPropertyOptional({ description: 'Prazo no formato AAAA-MM-DD', example: '2026-07-25' })
  @IsOptional()
  @Matches(DATA_ISO, { message: 'O prazo deve ser uma data no formato AAAA-MM-DD.' })
  prazo?: string | null;

  @ApiPropertyOptional({ description: 'Responsável pela execução. Null = ninguém ainda.' })
  @IsOptional()
  @ValidateIf((o: CriarTarefaDto) => o.responsavelId !== null)
  @IsUUID('4', { message: 'Informe um usuário válido ou null.' })
  responsavelId?: string | null;
}

export class EditarTarefaDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @Length(1, 300, { message: 'A tarefa precisa ter entre 1 e 300 caracteres.' })
  titulo?: string;

  @ApiPropertyOptional({ enum: TipoTarefa })
  @IsOptional()
  @IsEnum(TipoTarefa, { message: 'Tipo de tarefa inválido.' })
  tipo?: TipoTarefa;

  @ApiPropertyOptional({ description: 'AAAA-MM-DD, ou null para tirar o prazo' })
  @IsOptional()
  @ValidateIf((o: EditarTarefaDto) => o.prazo !== null)
  @Matches(DATA_ISO, { message: 'O prazo deve ser uma data no formato AAAA-MM-DD.' })
  prazo?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o: EditarTarefaDto) => o.responsavelId !== null)
  @IsUUID('4', { message: 'Informe um usuário válido ou null.' })
  responsavelId?: string | null;

  @ApiPropertyOptional({ description: 'true conclui, false reabre' })
  @IsOptional()
  @IsBoolean()
  concluida?: boolean;
}

export class CriarEtiquetaDto {
  @ApiProperty({ maxLength: 40 })
  @IsString()
  @Length(1, 40, { message: 'O nome da etiqueta precisa ter entre 1 e 40 caracteres.' })
  nome!: string;

  @ApiPropertyOptional({
    description: 'Token de cor do tema (ex.: marca-ciano, ok, alerta, erro).',
  })
  @IsOptional()
  @IsString()
  /* Lista fechada porque `cor` vira classe do Tailwind na tela. Texto livre aqui
     seria injeção de classe CSS — e um valor fora da paleta simplesmente não
     existe no CSS compilado, então a etiqueta ficaria invisível. */
  @Matches(/^(marca-ciano|marca-azul|marca-violeta|marca-ouro|ok|alerta|erro)$/, {
    message: 'Cor fora da paleta do tema.',
  })
  cor?: string;
}
