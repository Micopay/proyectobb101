import type { InputHTMLAttributes } from 'react';

/* Campo de texto — .ct-input de Contact.jsx: fondo crema, borde de 2 px de
   tinta, y al enfocar el borde pasa a naranja.

   Traducción táctil: 48 dp de alto mínimo y 16 px de tipo. Por debajo de
   16 px, varios WebView hacen zoom automático al enfocar el campo, y en un
   formulario de dinero eso descoloca la pantalla entera.

   El error va en --color-rojo (#c0392b), el que el sitio ya usaba en
   .ct-err. No se inventó un rojo nuevo. */

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  etiqueta?: string;
  error?: string | null;
  ayuda?: string;
}

export default function TextField({
  etiqueta,
  error,
  ayuda,
  className = '',
  id,
  ...rest
}: TextFieldProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="flex flex-col gap-1.5">
      {etiqueta ? (
        <label htmlFor={inputId} className="text-[13px] font-bold text-gris">
          {etiqueta}
        </label>
      ) : null}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={`min-h-12 w-full rounded-sm border-2 bg-fondo px-3.5 py-3 text-[16px] text-tinta outline-none transition-colors placeholder:text-gris focus:border-naranja ${
          error ? 'border-rojo' : 'border-tinta'
        } ${className}`}
        {...rest}
      />
      {error ? (
        <span className="text-[13px] font-semibold text-rojo">{error}</span>
      ) : ayuda ? (
        <span className="text-[13px] text-gris">{ayuda}</span>
      ) : null}
    </div>
  );
}
