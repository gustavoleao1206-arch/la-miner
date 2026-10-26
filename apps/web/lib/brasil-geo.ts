/**
 * Contorno real do Brasil em coordenadas geográficas (lon, lat).
 * Derivado das fronteiras oficiais e simplificado para ~110 vértices —
 * o suficiente para preservar os traços reconhecíveis:
 *   • bulbo norte (Roraima/Amapá)   • "bico" do Rio Grande do Norte
 *   • reentrância do Nordeste        • ponta sul do Rio Grande do Sul
 *   • protuberância oeste do Acre    • foz do Amazonas
 *
 * Antes eu usava uma poligonal inventada de 34 pontos: lia como "uma massa
 * de terra". Com a geometria real, lê como o Brasil.
 */
export const BRASIL_CONTORNO: [number, number][] = [
  // ── Norte: Amapá → foz do Amazonas
  [-51.6, 4.1], [-51.0, 3.4], [-50.5, 2.2], [-50.9, 1.2], [-50.3, 0.9],
  [-49.4, 0.2], [-48.6, -0.2], [-48.5, -1.2], [-47.5, -0.8], [-46.7, -1.1],
  // ── Costa Norte-Nordeste: Maranhão → Ceará
  [-45.5, -1.5], [-44.4, -2.4], [-43.5, -2.4], [-42.6, -2.5], [-41.8, -2.8],
  [-41.0, -2.9], [-40.2, -2.8], [-39.3, -3.0], [-38.5, -3.7], [-37.8, -4.3],
  // ── "Bico" do Rio Grande do Norte — o traço mais reconhecível
  [-37.2, -4.9], [-36.4, -5.1], [-35.5, -5.1], [-35.2, -5.8], [-34.9, -6.4],
  [-34.8, -7.1], [-34.9, -7.9], [-35.1, -8.6], [-35.6, -9.3], [-36.4, -10.0],
  // ── Costa Leste: Alagoas → Bahia
  [-37.1, -10.6], [-37.8, -11.2], [-38.5, -12.0], [-38.7, -12.9], [-38.9, -13.6],
  [-39.0, -14.5], [-38.9, -15.5], [-39.2, -16.4], [-39.7, -17.3], [-39.9, -18.2],
  // ── Espírito Santo → Rio de Janeiro
  [-40.4, -19.0], [-40.8, -19.8], [-41.5, -20.6], [-41.9, -21.3], [-42.7, -22.0],
  [-43.6, -22.5], [-44.5, -23.0], [-45.4, -23.4], [-46.4, -23.9], [-47.4, -24.5],
  // ── São Paulo → Sul
  [-48.2, -25.2], [-48.6, -26.0], [-48.6, -26.9], [-48.8, -27.7], [-49.4, -28.4],
  [-50.0, -29.2], [-50.7, -30.0], [-51.3, -30.8], [-51.9, -31.6], [-52.3, -32.4],
  [-52.7, -33.2], [-53.4, -33.7], [-53.5, -33.1], [-53.8, -32.4], [-54.6, -31.6],
  // ── Fronteira sul: Uruguai → Argentina
  [-55.6, -30.9], [-56.5, -30.2], [-57.2, -30.3], [-57.6, -30.0], [-56.8, -29.0],
  [-56.0, -28.4], [-55.4, -27.5], [-54.6, -26.8], [-54.3, -25.9], [-54.6, -25.1],
  // ── Paraguai → Bolívia
  [-54.3, -24.3], [-54.4, -23.5], [-55.1, -23.9], [-55.8, -22.9], [-56.5, -22.2],
  [-57.5, -22.1], [-57.9, -21.1], [-57.8, -20.1], [-58.2, -19.6], [-58.4, -18.6],
  [-59.6, -18.2], [-60.3, -16.3], [-60.5, -15.1], [-60.3, -14.0], [-61.0, -13.5],
  // ── Bolívia → Acre (a protuberância oeste)
  [-62.2, -13.0], [-63.1, -12.6], [-64.3, -12.5], [-65.4, -11.3], [-65.4, -10.5],
  [-66.6, -9.9], [-67.8, -10.7], [-69.4, -10.9], [-70.6, -11.0], [-70.6, -9.8],
  [-72.2, -10.0], [-72.9, -9.4], [-73.2, -8.7], [-74.0, -7.9], [-73.6, -7.3],
  // ── Peru → Colômbia
  [-73.0, -6.6], [-72.9, -5.1], [-71.9, -4.5], [-70.9, -4.2], [-70.0, -4.2],
  [-69.4, -1.2], [-69.8, -0.6], [-69.3, 0.6], [-69.8, 1.1], [-68.2, 1.7],
  // ── Venezuela → Roraima (bulbo norte) → Guianas
  [-67.9, 1.7], [-67.1, 2.3], [-67.3, 3.4], [-65.6, 4.1], [-64.5, 4.1],
  [-63.4, 3.9], [-62.1, 4.1], [-60.9, 4.5], [-60.6, 5.2], [-60.0, 5.3],
  [-59.8, 4.4], [-58.9, 4.2], [-58.0, 4.0], [-57.3, 3.4], [-56.5, 2.0],
  [-55.9, 2.5], [-55.2, 2.5], [-54.6, 2.3], [-54.2, 2.1], [-53.0, 2.2],
  [-52.6, 2.6], [-51.8, 3.9],
];

/**
 * As 27 capitais — nós de destaque do mapa.
 *
 * Eram só as 6 do TRF5, e o mapa do login desenhava o contorno do Brasil
 * inteiro com o Nordeste aceso e o resto do país apagado: a própria tela de
 * entrada anunciava que o produto era regional. Com a abrangência nacional, o
 * mapa acende o país todo.
 *
 * `trf` fica junto porque a capital é a âncora visual da região no mapa; quem
 * quiser destacar um tribunal filtra por aqui em vez de manter outra lista.
 */
export const CAPITAIS: { nome: string; uf: string; trf: string; lon: number; lat: number }[] = [
  // TRF1 — Norte, Centro-Oeste e parte do Nordeste
  { nome: 'Rio Branco', uf: 'AC', trf: 'TRF1', lon: -67.81, lat: -9.97 },
  { nome: 'Manaus', uf: 'AM', trf: 'TRF1', lon: -60.02, lat: -3.1 },
  { nome: 'Macapá', uf: 'AP', trf: 'TRF1', lon: -51.07, lat: 0.03 },
  { nome: 'Salvador', uf: 'BA', trf: 'TRF1', lon: -38.51, lat: -12.97 },
  { nome: 'Brasília', uf: 'DF', trf: 'TRF1', lon: -47.93, lat: -15.78 },
  { nome: 'Goiânia', uf: 'GO', trf: 'TRF1', lon: -49.25, lat: -16.68 },
  { nome: 'São Luís', uf: 'MA', trf: 'TRF1', lon: -44.3, lat: -2.53 },
  { nome: 'Cuiabá', uf: 'MT', trf: 'TRF1', lon: -56.1, lat: -15.6 },
  { nome: 'Belém', uf: 'PA', trf: 'TRF1', lon: -48.5, lat: -1.46 },
  { nome: 'Teresina', uf: 'PI', trf: 'TRF1', lon: -42.8, lat: -5.09 },
  { nome: 'Porto Velho', uf: 'RO', trf: 'TRF1', lon: -63.9, lat: -8.76 },
  { nome: 'Boa Vista', uf: 'RR', trf: 'TRF1', lon: -60.67, lat: 2.82 },
  { nome: 'Palmas', uf: 'TO', trf: 'TRF1', lon: -48.33, lat: -10.18 },
  // TRF2
  { nome: 'Vitória', uf: 'ES', trf: 'TRF2', lon: -40.34, lat: -20.32 },
  { nome: 'Rio de Janeiro', uf: 'RJ', trf: 'TRF2', lon: -43.2, lat: -22.91 },
  // TRF3
  { nome: 'Campo Grande', uf: 'MS', trf: 'TRF3', lon: -54.65, lat: -20.45 },
  { nome: 'São Paulo', uf: 'SP', trf: 'TRF3', lon: -46.63, lat: -23.55 },
  // TRF4 — Sul
  { nome: 'Curitiba', uf: 'PR', trf: 'TRF4', lon: -49.27, lat: -25.43 },
  { nome: 'Porto Alegre', uf: 'RS', trf: 'TRF4', lon: -51.23, lat: -30.03 },
  { nome: 'Florianópolis', uf: 'SC', trf: 'TRF4', lon: -48.55, lat: -27.59 },
  // TRF5 — Nordeste oriental
  { nome: 'Maceió', uf: 'AL', trf: 'TRF5', lon: -35.74, lat: -9.67 },
  { nome: 'Fortaleza', uf: 'CE', trf: 'TRF5', lon: -38.54, lat: -3.73 },
  { nome: 'João Pessoa', uf: 'PB', trf: 'TRF5', lon: -34.86, lat: -7.12 },
  { nome: 'Recife', uf: 'PE', trf: 'TRF5', lon: -34.88, lat: -8.05 },
  { nome: 'Natal', uf: 'RN', trf: 'TRF5', lon: -35.21, lat: -5.79 },
  { nome: 'Aracaju', uf: 'SE', trf: 'TRF5', lon: -37.07, lat: -10.91 },
  // TRF6
  { nome: 'Belo Horizonte', uf: 'MG', trf: 'TRF6', lon: -43.94, lat: -19.92 },
];

/** Extremos reais do território, para o enquadramento. */
export const LIMITES = { lonMin: -74, lonMax: -34.5, latMin: -33.9, latMax: 5.4 };
