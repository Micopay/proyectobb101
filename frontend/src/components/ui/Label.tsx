import type { ReactNode } from 'react';

/* Cintillo de sección — .label de mp-styles.css.
   No es texto pequeño en gris: es una etiqueta IMPRESA, papel sobre tinta,
   de canto vivo. Ese contraste invertido la hace legible de lejos sin
   depender de un gris claro.

   Sustituye al patrón que tenía la app —11 px en `text-outline-variant`—
   que medido en el dispositivo daba 1.44:1. Ver commit 2689612.

   Mayúsculas: aquí SÍ. ef5cbe4 dejó las mayúsculas de los títulos pendientes
   de decisión del equipo; el plan (D-2) recomienda limitarlas a cintillos y
   botones — en un rótulo de tres palabras funcionan, en un h1 de 360 dp
   roban dos líneas y frenan la lectura. */

interface LabelProps {
  children: ReactNode;
  /** 'claro' = sobre papel/fondo. 'oscuro' = sobre tinta. */
  tone?: 'claro' | 'oscuro';
  className?: string;
}

export default function Label({ children, tone = 'claro', className = '' }: LabelProps) {
  const paleta = tone === 'oscuro' ? 'bg-papel text-tinta' : 'bg-tinta text-papel';
  return (
    <span
      className={`inline-block px-2.5 py-1 text-[12px] font-bold uppercase tracking-[.14em] leading-none ${paleta} ${className}`}
    >
      {children}
    </span>
  );
}
