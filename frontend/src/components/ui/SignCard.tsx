import type { ReactNode } from 'react';

/* Tarjeta "letrero" — el patrón más representativo del sistema.
   Origen: .pv-card de Proveedores.jsx (micopay-landig @ c6b395f).

   Tres franjas separadas por reglas de 2 px:
     cabecera  verde suave, con el icono y una insignia
     cuerpo    el contenido
     pie       crema, dato secundario

   El icono va SUELTO sobre la cabecera. Nada de tile redondeado detrás: eso
   es lo que ef5cbe4 eliminó ("desaparece el tile de ícono redondeado sobre
   cada encabezado"), y la app lo repite unas 30 veces.

   Sin hover: el sitio lo reserva tras @media (hover:hover), en táctil no
   aplica. */

interface SignCardProps {
  cabecera: ReactNode;
  /** Esquina derecha de la cabecera: insignia, distancia, estado. */
  insignia?: ReactNode;
  children: ReactNode;
  pie?: ReactNode;
  className?: string;
  onClick?: () => void;
}

export default function SignCard({
  cabecera,
  insignia,
  children,
  pie,
  className = '',
  onClick,
}: SignCardProps) {
  return (
    <div
      onClick={onClick}
      className={`flex flex-col rounded-sm border-2 border-tinta bg-papel shadow-solida ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b-2 border-tinta bg-verde-suave px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-verde">{cabecera}</div>
        {insignia}
      </div>
      <div className="flex flex-col gap-3.5 px-3.5 py-4">{children}</div>
      {pie ? (
        <div className="border-t-2 border-tinta bg-fondo px-3.5 py-2.5 text-[12px] font-semibold text-gris">
          {pie}
        </div>
      ) : null}
    </div>
  );
}
