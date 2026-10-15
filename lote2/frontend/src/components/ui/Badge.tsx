import type { ReactNode } from 'react';

/* Insignia — .pv-badge-tier de Proveedores.jsx. Rectángulo de canto vivo con
   borde de 1.5 px. Sirve para niveles, estados de operación y contadores.

   El contador de notificaciones de la app era un círculo con `bg-error`, un
   token MUERTO (Tailwind v4 no cargaba tailwind.config.ts), así que se
   dibujaba sin fondo. Aquí es un cuadro naranja: una notificación pendiente
   en esta app casi siempre es "alguien quiere cobrarte o entregarte
   efectivo" — es acción, y la acción es naranja. */

type Tono = 'tinta' | 'naranja' | 'verde' | 'papel' | 'aviso';

interface BadgeProps {
  children: ReactNode;
  tono?: Tono;
  className?: string;
}

const TONOS: Record<Tono, string> = {
  tinta: 'bg-tinta text-papel',
  naranja: 'bg-naranja text-papel',
  verde: 'bg-verde-suave text-verde',
  papel: 'bg-papel text-tinta',
  aviso: 'bg-aviso text-aviso-texto',
};

export default function Badge({ children, tono = 'papel', className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-sm border-[1.5px] border-tinta px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.1em] leading-none ${TONOS[tono]} ${className}`}
    >
      {children}
    </span>
  );
}
