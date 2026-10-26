/**
 * Anonimização de endereço IP — a forma que o Guia da ANPD chama de
 * "truncamento": o IPv4 perde o último octeto, o IPv6 fica com o prefixo /48.
 *
 * ── POR QUE TRUNCAR, E NÃO HASHEAR ──
 *
 * Hash de IP é pseudonimização fraca: o espaço de IPv4 tem 4 bilhões de
 * valores e se enumera numa tarde, então um hash sem segredo se reverte e um
 * hash com segredo vira chave que precisa ser guardada e rotacionada. O IP
 * truncado não se reverte e ainda serve ao que a trilha precisa dele: dizer se
 * duas consultas vieram da mesma rede, não da mesma máquina.
 *
 * ── ONDE SE USA, E ONDE NÃO ──
 *
 * Usa-se na trilha de CONSULTA (quem olhou qual CPF): ali o dado que importa é
 * o usuário autenticado; o IP é coadjuvante. NÃO se usa no registro de LOGIN
 * (AuditLog) enquanto ele estiver dentro do prazo do art. 15 do Marco Civil —
 * a lei obriga a guardar o endereço IP completo dos acessos por 6 meses, para
 * entrega mediante ordem judicial, e IP truncado não cumpre essa ordem. Quem
 * anonimiza o AuditLog é o cron de retenção, DEPOIS do prazo.
 */
export function anonimizarIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const limpo = ip.trim().replace(/^::ffff:/, ''); // IPv4 mapeado em IPv6

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(limpo)) {
    const partes = limpo.split('.');
    partes[3] = '0';
    return partes.join('.');
  }

  if (limpo.includes(':')) {
    /* Expande o suficiente para ficar com os três primeiros grupos (/48). */
    const grupos = limpo.split('::')[0].split(':').filter(Boolean);
    const prefixo = [grupos[0] ?? '0', grupos[1] ?? '0', grupos[2] ?? '0'];
    return `${prefixo.join(':')}::`;
  }

  /* Formato inesperado: não guardar é a opção segura. */
  return null;
}
