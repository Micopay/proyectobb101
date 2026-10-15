import type { ReactNode } from 'react';

/* Tarjeta del sistema — .card de mp-styles.css.

   Dos traducciones a pantalla de 5-6":

   1. Padding 16 px, no los 24 px del sitio. Con 24 px más el margen de
      pantalla, en 360 dp no queda sitio para una cifra grande.

   2. Sombra de 4 px, no los 8 px de Conversor/Calculadora/Contact. La firma
      (borde 2 px + sombra) cuesta 6 px por lado; a 8 px se come el margen.
      Ver D-8 del plan.

   La sombra sólida se reserva a superficies principales: filas de lista,
   chips y campos NO la llevan. En el sitio tampoco. */

interface CardProps {
  children: ReactNode;
  /** Sin sombra: para tarjetas dentro de listas o rejillas densas. */
  plana?: boolean;
  superficie?: 'papel' | 'fondo' | 'tinta';
  className?: string;
  onClick?: () => void;
}

const SUPERFICIES = {
  papel: 'bg-papel text-tinta',
  fondo: 'bg-fondo text-tinta',
  tinta: 'bg-tinta text-papel',
} as const;

export default function Card({
  children,
  plana = false,
  superficie = 'papel',
  className = '',
  onClick,
}: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-sm border-2 border-tinta p-4 ${SUPERFICIES[superficie]} ${
        plana ? '' : 'shadow-solida'
      } ${className}`}
    >
      {children}
    </div>
  );
}
