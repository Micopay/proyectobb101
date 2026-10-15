/**
 * Armazon unico de onboarding.
 *
 * MicoPay tiene dos incorporaciones distintas y no se pueden mezclar:
 *
 *   · La de PERSONA es de comprension. La pasa todo el mundo una vez, no cambia
 *     nada en el sistema, y lo unico que cambia esta en la cabeza de quien la
 *     lee: que su dinero vive en este telefono, que hay una llave que puede
 *     perder, que va a quedar con alguien en persona y que el dinero esta
 *     retenido mientras tanto.
 *
 *   · La de AGENTE es de alta. La pasa solo quien decide poner efectivo en la
 *     red. Al terminar, el sistema tiene datos nuevos y esa persona es visible
 *     para desconocidos en un mapa.
 *
 * Lo que comparten es la forma: pasos numerados, uno cada vez, con salida en
 * cualquier momento. Por eso el armazon es uno solo y las dos incorporaciones
 * son datos, no pantallas nuevas. Anadir un paso es anadir un objeto.
 *
 * Accesibilidad que no es opcional aqui: el progreso se anuncia, el foco viaja
 * al titulo de cada paso (si no, un lector de pantalla se queda leyendo el paso
 * anterior) y el area tactil de los botones respeta el minimo de 48 dp.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export interface OnboardingStep {
  /** Identificador estable para tests y telemetria; no se muestra. */
  id: string;
  title: string;
  /** Frase corta bajo el titulo. Una idea, no un parrafo. */
  lead?: string;
  body: ReactNode;
  /** Texto del boton de avance. Por omision "Continuar". */
  nextLabel?: string;
  /**
   * Si devuelve false, el paso no deja avanzar. Sirve para los pasos que
   * dependen de algo real (una casilla completada, una respuesta del servidor)
   * y no solo de haber leido.
   */
  canAdvance?: boolean;
  /** Motivo visible cuando `canAdvance` es false. */
  blockedReason?: string;
}

interface Props {
  steps: OnboardingStep[];
  index: number;
  onIndexChange: (next: number) => void;
  /** Se llama al avanzar desde el ultimo paso. */
  onFinish: () => void;
  /** Salida visible siempre: nadie deberia quedar atrapado en un tutorial. */
  onExit?: () => void;
  exitLabel?: string;
  /** Deshabilita la navegacion mientras hay una peticion en vuelo. */
  busy?: boolean;
}

export default function OnboardingFlow({
  steps,
  index,
  onIndexChange,
  onFinish,
  onExit,
  exitLabel = 'Ahora no',
  busy = false,
}: Props) {
  const step = steps[index];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isLast = index === steps.length - 1;

  // El foco viaja al titulo en cada paso. Sin esto, quien usa lector de
  // pantalla avanza y sigue oyendo el paso anterior.
  useEffect(() => {
    headingRef.current?.focus();
  }, [index]);

  if (!step) return null;

  const blocked = step.canAdvance === false;

  return (
    <div className="bg-surface text-on-surface min-h-screen flex flex-col">
      <header className="border-b-2 border-tinta w-full sticky top-0 bg-[#E7F6FF] z-50 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4 gap-4">
          <p className="text-sm font-bold text-gris" aria-live="polite">
            Paso {index + 1} de {steps.length}
          </p>
          {onExit && (
            <button
              onClick={onExit}
              className="min-h-12 px-3 text-sm font-bold text-verde underline underline-offset-4"
            >
              {exitLabel}
            </button>
          )}
        </div>
        {/* Barra de progreso decorativa: el dato real ya va en el texto de
            arriba, que es lo que lee un lector de pantalla. */}
        <div className="h-1 bg-[#D6E9F2]" aria-hidden="true">
          <div
            className="h-full bg-verde transition-all duration-300"
            style={{ width: `${((index + 1) / steps.length) * 100}%` }}
          />
        </div>
      </header>

      <main className="flex-1 max-w-xl w-full mx-auto px-6 py-8 flex flex-col">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-headline font-extrabold text-2xl text-tinta outline-none"
        >
          {step.title}
        </h1>
        {step.lead && <p className="mt-2 text-base text-gris font-medium">{step.lead}</p>}

        <div className="mt-6 flex-1">{step.body}</div>

        {blocked && step.blockedReason && (
          <p className="mt-4 text-sm font-medium text-gris" role="status">
            {step.blockedReason}
          </p>
        )}
      </main>

      <footer className="border-t-2 border-tinta bg-surface px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="max-w-xl mx-auto flex gap-3">
          {index > 0 && (
            <button
              onClick={() => onIndexChange(index - 1)}
              disabled={busy}
              className="min-h-12 px-5 border-2 border-tinta text-tinta font-bold rounded-sm disabled:opacity-50"
            >
              Atrás
            </button>
          )}
          <button
            onClick={() => (isLast ? onFinish() : onIndexChange(index + 1))}
            disabled={busy || blocked}
            className="min-h-12 flex-1 bg-verde text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-50 disabled:active:translate-x-0 disabled:active:translate-y-0"
          >
            {busy ? 'Procesando…' : (step.nextLabel ?? 'Continuar')}
          </button>
        </div>
      </footer>
    </div>
  );
}

/** Bloque de texto de un paso. Existe para que los pasos no repitan clases. */
export function StepText({ children }: { children: ReactNode }) {
  return <p className="text-base leading-relaxed text-on-surface mb-4">{children}</p>;
}

/** Punto destacado dentro de un paso: icono + texto. */
export function StepPoint({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 mb-4">
      <span className="material-symbols-outlined text-verde shrink-0" aria-hidden="true">
        {icon}
      </span>
      <p className="text-base leading-relaxed text-on-surface">{children}</p>
    </div>
  );
}

/**
 * Casilla de la lista de alta. `done` viene del servidor, nunca de lo que la
 * app crea recordar: si el telefono y el servidor discrepan, manda el servidor.
 */
export function ChecklistItem({
  done,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  done: boolean;
  title: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-2 border-tinta rounded-sm p-4 mb-3 bg-papel">
      <span
        className={`material-symbols-outlined shrink-0 ${done ? 'text-verde' : 'text-gris'}`}
        aria-hidden="true"
      >
        {done ? 'check_circle' : 'radio_button_unchecked'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-on-surface">{title}</p>
        {/* El motivo lo redacta el servidor: es quien sabe por que falta. */}
        {!done && detail && <p className="text-sm text-gris mt-1">{detail}</p>}
        {!done && actionLabel && onAction && (
          <button
            onClick={onAction}
            className="mt-3 min-h-12 px-4 border-2 border-verde text-verde font-bold rounded-sm"
          >
            {actionLabel}
          </button>
        )}
      </div>
      <span className="sr-only">{done ? 'completado' : 'pendiente'}</span>
    </div>
  );
}
