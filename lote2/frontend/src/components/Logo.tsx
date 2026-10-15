/* Marca — alineada con el sitio (Nav.astro de micopay-landig @ c6b395f).
   Antes la app usaba #1A2830 / #1D9E75 / #00694C: tres colores que ya no
   existen en el sistema, y un verde para "Pay" donde el sitio pone naranja.
   Los colores salen de tokens, no incrustados, para que no vuelvan a
   desincronizarse como pasó con los SVG del sitio. */
export const Logo = () => (
  <div className="flex items-center gap-2.5">
    <svg
      fill="none"
      height="26"
      width="26"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="3" stroke="var(--color-tinta)" strokeWidth="2.5" />
      <circle cx="17" cy="17" r="3" stroke="var(--color-naranja)" strokeWidth="2.5" />
      <path d="M10 10L14 14" stroke="var(--color-tinta)" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
    <div
      className="font-display text-[20px] font-extrabold uppercase tracking-[-.02em]"
      style={{ fontVariationSettings: '"wdth" 112' }}
      translate="no"
    >
      <span className="text-tinta">Mico</span>
      <span className="text-naranja">Pay</span>
    </div>
  </div>
)
