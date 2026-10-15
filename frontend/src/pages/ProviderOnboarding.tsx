/**
 * Incorporacion de agente: alta, no comprension.
 *
 * Al terminar esto, el servidor tiene datos nuevos y esta persona es visible
 * para desconocidos en un mapa publico. Por eso, a diferencia del onboarding de
 * persona, cada paso aqui corresponde a un hecho verificable y la elegibilidad
 * la decide el servidor (`/merchants/me/readiness`), no la app.
 *
 * Reglas que la pantalla respeta y que vienen de RED-1:
 *
 *   · Unirse NO es activarse. Unirse deja la cuenta pendiente.
 *   · Activarse NO es ponerse disponible. Empezar a recibir operaciones es una
 *     tercera decision consciente.
 *   · La lista no se cachea como verdad: se relee del servidor al volver, para
 *     que el progreso sobreviva a cerrar la app y no dependa del telefono.
 *   · Ser agente no es un modo permanente: se puede seguir pidiendo cash-out
 *     como cliente sin cambiar nada.
 */

import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import OnboardingFlow, {
  StepText,
  StepPoint,
  ChecklistItem,
  type OnboardingStep,
} from '../components/onboarding/OnboardingFlow';
import {
  enrollAsProvider,
  fetchProviderReadiness,
  activateProvider,
  type ProviderReadiness,
} from '../services/api';

interface Props {
  token: string;
  onExit: () => void;
  /** Lleva a la verificación de identidad (Didit). */
  onOpenKyc: () => void;
  /** Lleva a los ajustes de agente: zona, comisión y límites. */
  onOpenSettings: () => void;
  /** Se llama cuando la persona queda activa, para refrescar la sesión. */
  onActivated?: () => void;
}

const ITEM_TITLE_KEYS: Record<string, string> = {
  kyc: 'providerOnboarding.itemTitles.kyc',
  location: 'providerOnboarding.itemTitles.location',
  limits: 'providerOnboarding.itemTitles.limits',
};

export default function ProviderOnboarding({
  token,
  onExit,
  onOpenKyc,
  onOpenSettings,
  onActivated,
}: Props) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [readiness, setReadiness] = useState<ProviderReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La verdad la manda el servidor, y se relee cada vez que se vuelve a esta
  // pantalla: si la persona completo el KYC en otra parte, aqui se refleja sin
  // que tenga que reiniciar nada.
  const refresh = useCallback(async () => {
    try {
      setReadiness(await fetchProviderReadiness(token));
      setError(null);
    } catch {
      setError(t('providerOnboarding.errors.fetchStatus'));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Al volver de KYC o de ajustes (la app queda en segundo plano) se recarga:
  // sin esto la lista muestra un estado viejo y la persona cree que fallo.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const status = readiness?.status ?? 'not_enrolled';

  const handleEnroll = async () => {
    setBusy(true);
    try {
      setReadiness(await enrollAsProvider(token));
      setError(null);
      setIndex((i) => i + 1);
    } catch (err) {
      setError(messageFrom(err, t('providerOnboarding.errors.enroll')));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async () => {
    setBusy(true);
    try {
      const next = await activateProvider(token);
      setReadiness(next);
      setError(null);
      onActivated?.();
      setIndex((i) => i + 1);
    } catch (err) {
      // La activación falla cerrada en el servidor. Si llega aquí es que la
      // lista cambió por debajo, así que se recarga en vez de insistir.
      setError(messageFrom(err, t('providerOnboarding.errors.activate')));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const steps: OnboardingStep[] = [
    {
      id: 'what',
      title: t('providerOnboarding.steps.what.title'),
      lead: t('providerOnboarding.steps.what.lead'),
      body: (
        <>
          <StepText>{t('providerOnboarding.steps.what.body')}</StepText>
          <StepPoint icon="storefront">
            <Trans
              i18nKey="providerOnboarding.steps.what.noBusiness"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="tune">
            <Trans
              i18nKey="providerOnboarding.steps.what.decisions"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="swap_horiz">
            <Trans
              i18nKey="providerOnboarding.steps.what.noMode"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
        </>
      ),
      nextLabel:
        status === 'not_enrolled'
          ? t('providerOnboarding.steps.what.join')
          : t('providerOnboarding.continue'),
    },
    {
      id: 'expect',
      title: t('providerOnboarding.steps.expect.title'),
      lead: t('providerOnboarding.steps.expect.lead'),
      body: (
        <>
          <StepPoint icon="badge">
            <Trans
              i18nKey="providerOnboarding.steps.expect.identity"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="location_on">
            <Trans
              i18nKey="providerOnboarding.steps.expect.area"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="account_balance_wallet">
            <Trans
              i18nKey="providerOnboarding.steps.expect.cash"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="schedule">
            <Trans
              i18nKey="providerOnboarding.steps.expect.meetup"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
        </>
      ),
    },
    {
      id: 'checklist',
      title: t('providerOnboarding.steps.checklist.title'),
      lead: t('providerOnboarding.steps.checklist.lead'),
      body: (
        <>
          {!readiness && !error && <StepText>{t('providerOnboarding.loadingStatus')}</StepText>}
          {readiness?.items.map((item) => (
            <ChecklistItem
              key={item.key}
              done={item.done}
              title={t(ITEM_TITLE_KEYS[item.key] ?? item.key)}
              detail={item.detail}
              actionLabel={
                item.key === 'kyc'
                  ? t('providerOnboarding.steps.checklist.verify')
                  : t('providerOnboarding.steps.checklist.configure')
              }
              onAction={item.key === 'kyc' ? onOpenKyc : onOpenSettings}
            />
          ))}
          {readiness && !readiness.can_activate && (
            <StepText>
              {t('providerOnboarding.steps.checklist.refreshHint')}
            </StepText>
          )}
        </>
      ),
      nextLabel: t('providerOnboarding.steps.checklist.activate'),
      // La app no deduce la elegibilidad sumando casillas: usa la decisión del
      // servidor, que es quien la va a aplicar de todos modos.
      canAdvance: readiness?.can_activate === true || status === 'active',
      blockedReason:
        status === 'suspended'
          ? t('providerOnboarding.steps.checklist.suspended')
          : t('providerOnboarding.steps.checklist.blocked'),
    },
    {
      id: 'done',
      title: t('providerOnboarding.steps.done.title'),
      lead: t('providerOnboarding.steps.done.lead'),
      body: (
        <>
          <StepText>
            <Trans
              i18nKey="providerOnboarding.steps.done.body"
              components={{ strong: <strong /> }}
            />
          </StepText>
          <StepPoint icon="toggle_on">
            <Trans
              i18nKey="providerOnboarding.steps.done.available"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
          <StepPoint icon="pause_circle">
            <Trans
              i18nKey="providerOnboarding.steps.done.pause"
              components={{ strong: <strong /> }}
            />
          </StepPoint>
        </>
      ),
      nextLabel: t('providerOnboarding.steps.done.profile'),
    },
  ];

  const handleFinish = () => onExit();

  const handleIndexChange = (next: number) => {
    // Avanzar desde el primer paso ES el alta. Se hace aquí para que unirse sea
    // un acto explícito de la persona y no un efecto de abrir la pantalla.
    if (next === 1 && index === 0 && status === 'not_enrolled') {
      void handleEnroll();
      return;
    }
    if (next === 3 && index === 2 && status !== 'active') {
      void handleActivate();
      return;
    }
    setIndex(next);
  };

  return (
    <>
      {error && (
        <div
          role="alert"
          className="bg-error/10 border-b-2 border-error px-6 py-3 text-sm font-bold text-error"
        >
          {error}
        </div>
      )}
      <OnboardingFlow
        steps={steps}
        index={index}
        onIndexChange={handleIndexChange}
        onFinish={handleFinish}
        onExit={onExit}
        busy={busy}
      />
    </>
  );
}

function messageFrom(err: unknown, fallback: string): string {
  const res = (err as { response?: { data?: { message?: string } } })?.response;
  return res?.data?.message || fallback;
}
