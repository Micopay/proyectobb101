import type { ReactNode } from 'react';

/* Bloque de dinero — patrón de .cv-resumen (Conversor.jsx) y .cl-resultado
   (Calculadora.jsx): tinta sólida de fondo, etiqueta en gris-3 y la cifra
   grande en color.

   AQUÍ VIVE LA REGLA QUE CARGA EL PRODUCTO:

     saldo -> verde brillo.  Dinero DIGITAL que tienes.       7.62:1 sobre tinta
     cobro -> naranja claro. EFECTIVO que vas a recibir.      5.80:1 sobre tinta

   En el sitio las tres cifras naranjas son "Recibes aprox.", "Recibes con
   250 USDC" y "Ganancia estimada": las tres son dinero por recibir, ninguna
   es un saldo. Por eso el saldo de Home va en verde aunque esté denominado
   en pesos — corrige lo que decía la primera versión del plan.

   En una pantalla de operación se ve la cifra verde convertirse en la
   naranja: el color narra la conversión sin una sola etiqueta.

   `num` (tabular-nums) no es decorativo: sin él la cifra cambia de ancho al
   refrescarse y el número baila. */

interface MoneyBlockProps {
  /** Cintillo superior. Ej: "Valor total". */
  etiqueta: string;
  /** La cifra ya formateada. Ej: "$27,869.27 MXN". */
  cifra: string;
  /** saldo = digital (verde) · cobro = efectivo por recibir (naranja). */
  tipo?: 'saldo' | 'cobro';
  pie?: ReactNode;
  className?: string;
  onClick?: () => void;
}

export default function MoneyBlock({
  etiqueta,
  cifra,
  tipo = 'saldo',
  pie,
  className = '',
  onClick,
}: MoneyBlockProps) {
  const colorCifra = tipo === 'saldo' ? 'text-verde-brillo' : 'text-naranja-claro';
  return (
    <div
      onClick={onClick}
      className={`rounded-sm border-2 border-tinta bg-tinta p-5 shadow-solida ${className}`}
    >
      <div className="text-[11px] font-bold uppercase tracking-[.12em] text-gris-3">
        {etiqueta}
      </div>
      <div
        className={`num mt-1.5 font-display text-[34px] font-extrabold leading-none tracking-[-.02em] ${colorCifra}`}
        style={{ fontVariationSettings: '"wdth" 108' }}
        translate="no"
      >
        {cifra}
      </div>
      {pie ? <div className="mt-2.5 text-[13px] text-gris-3">{pie}</div> : null}
    </div>
  );
}
