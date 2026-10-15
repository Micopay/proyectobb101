/* Hongo de la red micelial — SVG del sitio (Conversor.jsx de
   micopay-landig @ c6b395f), trazo por trazo.

   Sustituye a public/mushroom_{red,green,gold}.png, que son de la paleta
   anterior y además pesan tres archivos rasterizados. El comentario del
   sitio explica las proporciones: sombrero alto que sobresale y tallo grueso
   con base ensanchada, calibrado para reconocerse a ~60 px. El tallo va
   primero para que el sombrero lo tape y el borde quede limpio.

   El tier cambia SOLO el color del sombrero, siguiendo .pv-badge-tier:
     maestro  -> tinta      (el más alto, el más contrastado)
     avanzado -> naranja
     inicial  -> papel

   Nota: el marcador del mapa vive en MapReal, que está en feat/map-real y
   todavía no existe en esta rama. Este componente queda listo para cuando
   aterrice; mientras tanto sirve para cualquier superficie que necesite la
   marca de proveedor. */

type Tier = 'maestro' | 'avanzado' | 'inicial';

const SOMBRERO: Record<Tier, string> = {
  maestro: 'var(--color-tinta)',
  avanzado: 'var(--color-naranja)',
  inicial: 'var(--color-papel)',
};

/* Los lunares tienen que verse sobre su propio sombrero: en tinta serían
   invisibles sobre el sombrero de tinta del nivel maestro. */
const LUNARES: Record<Tier, string> = {
  maestro: 'var(--color-papel)',
  avanzado: 'var(--color-tinta)',
  inicial: 'var(--color-tinta)',
};

interface HongoProps {
  tier?: Tier;
  size?: number;
  className?: string;
}

export default function Hongo({ tier = 'avanzado', size = 40, className = '' }: HongoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M23 30v17a9 7 0 0 0 18 0V30Z"
        fill="var(--color-fondo)"
        stroke="var(--color-tinta)"
        strokeWidth="2"
      />
      <path
        d="M4 33C4 16 17 5 32 5s28 11 28 28Z"
        fill={SOMBRERO[tier]}
        stroke="var(--color-tinta)"
        strokeWidth="2"
      />
      <circle cx="20" cy="21" r="3.4" fill={LUNARES[tier]} />
      <circle cx="41" cy="16" r="4.2" fill={LUNARES[tier]} />
    </svg>
  );
}
