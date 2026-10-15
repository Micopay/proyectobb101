/**
 * Incorporacion de persona: comprension, no alta.
 *
 * No cambia nada en el servidor. Al terminar, en la base de datos no hay ni un
 * campo distinto — lo unico que cambia esta en la cabeza de quien lo lee. Por
 * eso el "ya visto" se guarda solo en el dispositivo.
 *
 * Cubre las cuatro cosas que una persona necesita entender ANTES de mover
 * dinero, y que hasta ahora no le decia nadie:
 *
 *   1. Su dinero vive en este telefono. Nadie mas lo tiene.
 *   2. Hay una llave. Si la pierde sin respaldo, pierde los fondos.
 *   3. Que es un cash-out y por que el dinero queda retenido.
 *   4. Que va a quedar con una persona real, y que el codigo QR es lo que
 *      cierra la operacion.
 *
 * El punto 3 es el que faltaba por completo: P0-5 se cerro en agosto dando por
 * cubierto el onboarding, pero sus seis criterios hablaban solo de la wallet.
 * Nadie explicaba el producto.
 */

import { useState } from 'react';
import OnboardingFlow, {
  StepText,
  StepPoint,
  type OnboardingStep,
} from '../components/onboarding/OnboardingFlow';

interface Props {
  /** Alias de la persona, para que el saludo no sea generico. */
  username?: string | null;
  /** Se llama al terminar o al salir: el llamador marca el "ya visto". */
  onDone: () => void;
  /** Lleva al respaldo de la llave secreta. */
  onBackupKey?: () => void;
}

export default function Welcome({ username, onDone, onBackupKey }: Props) {
  const [index, setIndex] = useState(0);

  const steps: OnboardingStep[] = [
    {
      id: 'wallet',
      title: username ? `Hola, ${username}` : 'Tu dinero, en tu teléfono',
      lead: 'Antes de empezar, tres minutos que te pueden ahorrar un disgusto.',
      body: (
        <>
          <StepText>
            MicoPay te acaba de crear una <strong>cuenta propia</strong> dentro de este teléfono.
            No es como la app de un banco: aquí nosotros no guardamos tu dinero ni podemos
            moverlo. Solo tú.
          </StepText>
          <StepPoint icon="lock">
            Tu cuenta está protegida por una <strong>llave secreta</strong> que vive únicamente en
            este dispositivo y nunca sale de él.
          </StepPoint>
          <StepPoint icon="warning">
            Eso también significa que <strong>si pierdes el teléfono y no respaldaste tu llave,
            nadie puede devolverte tus fondos</strong>. Ni nosotros. No es un trámite que se pueda
            reponer.
          </StepPoint>
        </>
      ),
    },
    {
      id: 'backup',
      title: 'Respalda tu llave',
      lead: 'Es el único paso que no se puede deshacer más tarde.',
      body: (
        <>
          <StepText>
            Guarda tu llave secreta en un lugar seguro y fuera del teléfono: escrita en papel, o
            en un gestor de contraseñas. Quien tenga esa llave controla tus fondos, así que no la
            compartas con nadie, por mucho que te la pidan.
          </StepText>
          <StepText>
            Puedes explorar la app sin respaldarla, pero te la vamos a pedir antes de tu primera
            operación con dinero.
          </StepText>
          {onBackupKey && (
            <button
              onClick={onBackupKey}
              className="min-h-12 w-full mt-2 border-2 border-verde text-verde font-bold rounded-sm"
            >
              Respaldar mi llave ahora
            </button>
          )}
        </>
      ),
    },
    {
      id: 'cashout',
      title: 'Cómo cambias efectivo',
      lead: 'MicoPay conecta personas, no sucursales.',
      body: (
        <>
          <StepText>
            En MicoPay quien te da o te recibe el efectivo es otra persona: un{' '}
            <strong>agente</strong> de Red MicoPay. Puede ser una tienda, un puesto o un
            particular cerca de ti.
          </StepText>
          <StepPoint icon="sell">
            <strong>Convertir a efectivo:</strong> tú entregas cripto y el agente te da billetes.
          </StepPoint>
          <StepPoint icon="payments">
            <strong>Comprar con efectivo:</strong> tú entregas billetes y el agente te da cripto.
          </StepPoint>
          <StepText>
            El agente cobra una pequeña comisión que ves antes de aceptar. Sin sorpresas después.
          </StepText>
        </>
      ),
    },
    {
      id: 'escrow',
      title: 'Por qué es seguro',
      lead: 'El dinero queda retenido hasta que el intercambio ocurre.',
      body: (
        <>
          <StepText>
            Cuando aceptas una operación, la cripto no se le entrega a nadie todavía:{' '}
            <strong>queda bloqueada en garantía</strong>, fuera del alcance de las dos partes.
          </StepText>
          <StepPoint icon="handshake">
            Se libera únicamente cuando el efectivo cambia de manos y ambos lo confirman en la
            app.
          </StepPoint>
          <StepPoint icon="schedule">
            Si la operación no se completa a tiempo, <strong>recuperas tus fondos</strong>. La app
            te muestra el botón para hacerlo.
          </StepPoint>
          <StepText>
            Por eso ninguna de las dos partes puede quedarse con el dinero y desaparecer.
          </StepText>
        </>
      ),
    },
    {
      id: 'meeting',
      title: 'El encuentro',
      lead: 'Esto pasa en persona. Conviene saberlo de antemano.',
      body: (
        <>
          <StepPoint icon="location_on">
            Verás la <strong>zona</strong> del agente antes de aceptar. La dirección exacta solo
            aparece cuando la operación está en marcha, y solo para ustedes dos.
          </StepPoint>
          <StepPoint icon="qr_code_2">
            Al encontrarse, uno muestra un <strong>código QR</strong> y el otro lo escanea. Ese
            escaneo es la constancia de que el efectivo se entregó.
          </StepPoint>
          <StepPoint icon="shield">
            Queden en un <strong>lugar público y concurrido</strong>, de día. Si algo te incomoda,
            cancela: no estás obligado a completar nada.
          </StepPoint>
        </>
      ),
      nextLabel: 'Entendido, empezar',
    },
  ];

  return (
    <OnboardingFlow
      steps={steps}
      index={index}
      onIndexChange={setIndex}
      onFinish={onDone}
      onExit={onDone}
      exitLabel="Saltar"
    />
  );
}
