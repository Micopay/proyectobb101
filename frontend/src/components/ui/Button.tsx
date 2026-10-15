import type { ButtonHTMLAttributes, ReactNode } from 'react';

/* Botón del sistema "Mercado / Rótulo".
   Origen: .btn de mp-styles.css del sitio (micopay-landig @ c6b395f).

   Tres traducciones deliberadas del web a táctil:

   1. Sin :hover. El sitio cambia de fondo al pasar el puntero; en un teléfono
      no hay puntero, y en Android un :hover se queda "pegado" tras el toque.
      El sitio ya reserva sus hovers tras @media (hover:hover) — aquí
      simplemente no existen.

   2. El :active se conserva TAL CUAL: el botón se desplaza 3 px sobre su
      propia sombra, que baja a 1 px. Es la mejor parte del sistema en táctil
      — se siente como un sello, no como un rebote. Sustituye al
      `active:scale-90` que usaba la app.

   3. Área táctil mínima de 48 dp (min-h-12).

   Color: el naranja es direccional. `primary` va sobre fondo CLARO, que es
   donde vive --color-naranja (5.13:1 con papel). Sobre tinta, tone="oscuro". */

type Variante = 'primary' | 'ghost' | 'peligro';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variante;
  /** 'claro' (por defecto) = sobre papel/fondo. 'oscuro' = sobre tinta. */
  tone?: 'claro' | 'oscuro';
  block?: boolean;
  children: ReactNode;
}

const BASE =
  'inline-flex items-center justify-center gap-2.5 min-h-12 px-6 py-3.5 ' +
  'rounded-sm border-2 font-bold text-[17px] tracking-[.01em] ' +
  'transition-[transform,box-shadow,background-color] duration-100 ease-out ' +
  'active:translate-x-[3px] active:translate-y-[3px] ' +
  'disabled:opacity-45 disabled:shadow-none disabled:translate-x-0 ' +
  'disabled:translate-y-0 disabled:cursor-not-allowed ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2';

/* 17 px y no los 15 px del sitio: a 15/700 el papel sobre naranja da 5.13:1
   y pasa AA, pero en 360 dp de ancho un botón principal de 15 px se lee peor
   que el resto de la jerarquía. Es legibilidad, no contraste. */
const CLARO: Record<Variante, string> = {
  primary: 'bg-naranja text-papel border-tinta shadow-solida',
  ghost: 'bg-papel text-tinta border-tinta shadow-solida',
  peligro: 'bg-rojo text-papel border-tinta shadow-solida',
};

/* Sobre tinta la sombra en tinta sería invisible: pasa a papel. */
const OSCURO: Record<Variante, string> = {
  primary: 'bg-naranja-claro text-tinta border-papel shadow-solida-inv',
  ghost: 'bg-transparent text-papel border-papel shadow-solida-inv',
  peligro: 'bg-rojo text-papel border-papel shadow-solida-inv',
};

export default function Button({
  variant = 'primary',
  tone = 'claro',
  block = false,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const oscuro = tone === 'oscuro';
  const paleta = oscuro ? OSCURO[variant] : CLARO[variant];
  const foco = oscuro ? 'focus-visible:outline-papel' : 'focus-visible:outline-tinta';
  const activo = oscuro ? 'active:shadow-solida-inv-xs' : 'active:shadow-solida-xs';
  return (
    <button
      className={`${BASE} ${paleta} ${foco} ${activo} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
