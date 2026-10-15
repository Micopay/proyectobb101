/* Franja de beta en red de prueba — §4.7 del plan.

   El texto es LITERALMENTE el del sitio (AvisoBeta.astro de
   micopay-landig @ c6b395f). No se redactó nada nuevo: es la misma frase ya
   publicada y revisada.

   Va arriba del contenido, antes del saldo, por la misma razón que en el
   sitio: la cifra de Home se lee como un saldo real, así que el aviso tiene
   que verse ANTES de leerla. El comentario de AvisoBeta.astro lo explica
   para el hero; en la app aplica con más fuerza, porque aquí hay una cifra
   grande en pesos.

   No es descartable. Es la única pieza del chrome que no se puede cerrar.

   Colores: los tres del sitio, promovidos a token en F0a
   (--color-aviso / -borde / -texto). Contraste medido: 5.06:1, pasa AA.

   Se oculta sola en mainnet: si algún día VITE_STELLAR_NETWORK deja de ser
   TESTNET, la franja desaparece sin tener que acordarse de quitarla. */

const ES_PRUEBA =
  (import.meta.env.VITE_STELLAR_NETWORK ?? 'TESTNET').toUpperCase() !== 'PUBLIC';

export default function BetaBanner({ className = '' }: { className?: string }) {
  if (!ES_PRUEBA) return null;
  return (
    <div
      role="status"
      className={`flex items-start gap-2.5 border-b-2 border-aviso-borde bg-aviso px-4 py-3 ${className}`}
    >
      <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[18px] text-aviso-texto">
        science
      </span>
      <p className="text-[13px] leading-snug text-aviso-texto">
        <strong className="font-extrabold">Beta técnica en red de prueba.</strong>{' '}
        No se mueve dinero real: los saldos son simulados y los tokens no tienen valor.
      </p>
    </div>
  );
}
