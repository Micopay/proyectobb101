import type { InputHTMLAttributes } from 'react';

/* Campo de monto — .cv-input-row del Conversor del sitio.

   Caja de fondo crema con borde de 2 px, la divisa como cintillo a la
   izquierda y la cifra alineada a la derecha en tipo de display.

   Tres cosas que no son decorativas:

   1. `num` (tabular-nums). Sin esto la cifra cambia de ancho mientras se
      teclea y el campo "salta". En un formulario de dinero eso se lee como
      que algo va mal.

   2. inputMode="decimal" y no type="number". El type numérico saca en
      Android un teclado que en algunos fabricantes no trae punto decimal, y
      además permite notación científica.

   3. El cintillo de divisa es VERDE, no naranja: dentro del campo lo que se
      escribe todavía es dinero digital. El naranja aparece en el resultado,
      cuando ya es efectivo por recibir. Es la misma secuencia que el sitio
      hace en Conversor.jsx: moneda verde arriba, cifra naranja abajo. */

interface AmountFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Código que se muestra en el cintillo. Ej: "MXN", "USDC". */
  divisa: string;
  etiqueta?: string;
  error?: string | null;
  ayuda?: string;
}

export default function AmountField({
  divisa,
  etiqueta,
  error,
  ayuda,
  className = '',
  id,
  ...rest
}: AmountFieldProps) {
  const inputId = id ?? rest.name ?? 'monto';
  return (
    <div className="flex flex-col gap-1.5">
      {etiqueta ? (
        <label htmlFor={inputId} className="text-[13px] font-bold text-gris">
          {etiqueta}
        </label>
      ) : null}
      <div
        className={`flex min-h-14 items-center gap-3 rounded-sm border-2 bg-fondo px-3 py-2 ${
          error ? 'border-rojo' : 'border-tinta'
        } ${className}`}
      >
        <span className="rounded-sm bg-verde px-2 py-1 text-[12px] font-bold text-papel">
          {divisa}
        </span>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          aria-invalid={error ? true : undefined}
          className="num min-w-0 flex-1 border-none bg-transparent p-0 text-right font-display text-[26px] font-bold text-tinta outline-none placeholder:text-gris-3"
          {...rest}
        />
      </div>
      {error ? (
        <span className="text-[13px] font-semibold text-rojo">{error}</span>
      ) : ayuda ? (
        <span className="text-[13px] text-gris">{ayuda}</span>
      ) : null}
    </div>
  );
}
