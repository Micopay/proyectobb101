import type { ButtonHTMLAttributes, ReactNode } from 'react';

/* Píldora de filtro — .pill de mp-styles.css, con el estado activo como
   cintillo de tinta invertido, no como relleno de color.

   Traducción obligatoria: la .pill del sitio mide ~43 dp de alto
   (9 px de padding + 13 px de texto), POR DEBAJO del mínimo táctil de 48 dp
   de Android. Sube a 13 px de padding y 14 px de texto. Es la única medida
   del sistema que no se puede portar tal cual. */

interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  activa?: boolean;
  children: ReactNode;
}

export default function Pill({ activa = false, className = '', children, ...rest }: PillProps) {
  return (
    <button
      type="button"
      data-on={activa}
      aria-pressed={activa}
      className={`inline-flex min-h-12 items-center gap-2 whitespace-nowrap rounded-sm border-2 border-tinta px-[18px] py-[13px] text-[14px] font-bold tracking-[.02em] transition-colors duration-150 active:translate-x-[2px] active:translate-y-[2px] ${
        activa ? 'bg-tinta text-papel' : 'bg-papel text-tinta'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
