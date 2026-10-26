'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * O revelador da jazida — TODA animação de entrada da landing passa por aqui.
 *
 * Um invólucro só, por disciplina: o orçamento de movimento aprovado é
 * "anima UMA vez ao entrar na viewport, 300–450ms, e para". Espalhar
 * motion.div pelas seções convidaria cada uma a inventar seu timing; com o
 * funil único, mudar o orçamento é mudar um arquivo.
 *
 * `useReducedMotion` porque o whileInView do framer-motion NÃO respeita a
 * preferência sozinho: sem este desvio, quem pediu menos movimento receberia
 * a página piscando igual.
 */
export function Revelar({
  children,
  atraso = 0,
  className,
}: {
  children: React.ReactNode;
  atraso?: number;
  className?: string;
}) {
  const semMovimento = useReducedMotion();

  if (semMovimento) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.45, delay: atraso, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
