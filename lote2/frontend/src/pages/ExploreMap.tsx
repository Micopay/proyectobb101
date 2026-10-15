import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import MapReal from '../components/MapReal';
import { useMerchantsAvailable } from '../hooks/useMerchantsAvailable';
import {
  effectiveFeePercent,
  MAX_EFFECTIVE_FEE_PERCENT,
  type AvailableMerchant,
} from '../services/api';
import { PLATFORM_FEE_PERCENT } from '../constants/trade';
import ErrorBanner from '../components/ErrorBanner';
import MerchantOfferCard from '../components/MerchantOfferCard';
import type { ApiErrorAction } from '../utils/apiError';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function walkMinutes(km: number): number {
  return Math.max(1, Math.round((km / 5) * 60));
}

// ─── Offer shape used by the card renderer ───────────────────────────────────

interface Offer {
  id: string;
  name: string;
  icon: string;
  distance: string;
  walkMinutes: number;
  receiveMxn: number;
  /** Provider commission (%). */
  commissionPct: number;
  /** Platform fee (%) — the other half of the effective cost. */
  platformFeePct: number;
  /** Desglose en MXN, tal y como lo calcula el servidor. */
  platformFeeMxn?: number;
  providerFeeMxn?: number;
  badge?: string;
  isPrimary?: boolean;
  completionRate?: number;
  tradesCompleted?: number;
  tier?: string;
  isBusiness?: boolean;
}

function merchantToOffer(m: AvailableMerchant, index: number): Offer {
  return {
    id: m.seller_id,
    name: m.username,
    icon: 'storefront',
    distance: formatDistance(m.distance_km),
    walkMinutes: walkMinutes(m.distance_km),
    receiveMxn: m.payout_mxn,
    commissionPct: m.rate_percent,
    platformFeePct: m.platform_fee_pct ?? PLATFORM_FEE_PERCENT,
    platformFeeMxn: m.platform_fee_mxn,
    providerFeeMxn: m.provider_fee_mxn,
    isPrimary: index === 0,
    completionRate: m.completion_rate ?? 0,
    tradesCompleted: m.trades_completed ?? 0,
    tier: m.tier ?? undefined,
    isBusiness: (m.seller_type === 'business') || (m.is_business === true) || false,
  };
}

export interface OfferConfirmData {
  id: string;
  name: string;
  receiveMxn: number;
  /** H5: lo que le cuesta al cliente, calculado por el servidor. */
  clientPaysMxn?: number;
  commissionPct: number;
  /** Desglose del servidor, arrastrado hasta la confirmacion sin recalcular. */
  platformFeeMxn?: number;
  providerFeeMxn?: number;
  nearbyCount: number;
}

interface ExploreMapProps {
  onBack: () => void;
  onSelectOffer: (offerId: string) => void;
  onProceedToConfirm?: (offer: OfferConfirmData) => void;
  amount?: number;
  loading?: boolean;
  creationError?: string | null;
  creationErrorAction?: ApiErrorAction;
  onDismissCreationError?: () => void;
  onRetryCreationError?: () => void;
  /** Effective-fee threshold (%) above which a warning is shown. Defaults to the shared guardrail. */
  maxEffectiveFeePercent?: number;
}

// ─── Effective cost (provider + platform) + over-threshold warning ────────────

function EffectiveFeeNote({
  commissionPct,
  platformFeePct,
  maxPct,
}: {
  commissionPct: number;
  platformFeePct: number;
  maxPct: number;
}) {
  const { t } = useTranslation();
  const totalPct = effectiveFeePercent(commissionPct, platformFeePct);
  const exceeds = totalPct > maxPct;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-gris uppercase tracking-wider">
          {t('map.totalEffectiveCost')}
        </span>
        <span
          className={`text-sm font-bold tabular-nums ${exceeds ? 'text-error' : 'text-on-surface'}`}
        >
          {totalPct.toFixed(1)}%
        </span>
      </div>
      <p className="text-[11px] text-gris font-medium">
        {t('map.feeBreakdown', { platformPct: platformFeePct, providerPct: commissionPct })}
      </p>
      {exceeds && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-sm border border-error/30 bg-error/5 px-3 py-2"
        >
          <span className="material-symbols-outlined text-error text-base leading-none">warning</span>
          <p className="text-[12px] font-medium text-error leading-snug">
            {t('map.feeExceedsWarning', { maxPct })}
          </p>
        </div>
      )}
    </div>
  );
}

const ExploreMap = ({
  onBack,
  onSelectOffer,
  onProceedToConfirm,
  amount = 500,
  loading = false,
  creationError,
  creationErrorAction = 'retry',
  onDismissCreationError,
  onRetryCreationError,
  maxEffectiveFeePercent = MAX_EFFECTIVE_FEE_PERCENT,
}: ExploreMapProps) => {
  const { t } = useTranslation();
  const [selectedMerchantId, setSelectedMerchantId] = useState<string | null>(null);
  const selectedOfferRef = useRef<HTMLElement | null>(null);
  const { state, refetch } = useMerchantsAvailable({
    amount_mxn: amount,
    flow: 'cashout',
    radius_km: 50,
  });

  useEffect(() => {
    selectedOfferRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedMerchantId]);

  if (state.status === 'loading' || state.status === 'idle') {
    return <LoadingSkeleton onBack={onBack} />;
  }

  if (state.status === 'location_denied') {
    return <LocationDenied onBack={onBack} />;
  }

  if (state.status === 'error') {
    return <FetchError onBack={onBack} onRetry={refetch} detail={state.error} />;
  }

  const merchants = state.status === 'success' ? state.merchants : [];
  const offers: Offer[] = merchants.map((m, i) => merchantToOffer(m, i));

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-screen pb-24">
      {/* Top Navigation */}
      <header className="border-b-2 border-tinta fixed top-0 left-0 w-full z-50 flex items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel ">
        <button
          onClick={onBack}
          className="min-h-12 min-w-12 flex items-center justify-center p-2 rounded-sm hover:bg-surface-container-low transition-colors duration-200"
          aria-label="Volver"
        >
          <span className="material-symbols-outlined text-verde">arrow_back</span>
        </button>
        <h1 className="ml-4 font-headline font-bold text-xl text-tinta tracking-tight">
          {t('map.title')}
        </h1>
      </header>

      <main className="pt-[calc(6rem+env(safe-area-inset-top))] px-6 max-w-2xl mx-auto">
        {creationError ? (
          <ErrorBanner
            message={creationError}
            action={creationErrorAction}
            onRetry={onRetryCreationError}
            onDismiss={onDismissCreationError}
            supportState="TRADE_CREATE"
            className="mb-6"
          />
        ) : null}

        {/* Map Section */}
        <section className="mb-10">
          <MapReal
            merchants={merchants}
            selectedMerchantId={selectedMerchantId}
            onSelectMerchant={setSelectedMerchantId}
            userPosition={state.status === 'success' ? state.userPosition : null}
          />
        </section>

        {offers.length === 0 ? (
          <EmptyState onBack={onBack} amount={amount} />
        ) : (
          <>
            {/* Results Header */}
            <div className="mb-6">
              <h2 className="font-headline font-bold text-2xl text-on-surface">
                {offers.length} {offers.length === 1 ? t('map.offer') : t('map.offers')} {t('map.for', { amount })}
              </h2>
              <div className="flex items-center gap-1 mt-1">
                <span className="material-symbols-outlined text-verde text-sm">location_on</span>
                <p className="text-sm text-gris font-medium">{t('map.nearYou')}</p>
              </div>
            </div>

            {/* Offers List */}
            {/* Offers List
                Antes habia aqui una tarjeta propia, del sistema ANTERIOR al
                rediseño: borde de 1 px casi invisible, sin sombra, insignias en
                pildora y un `ring` difuminado. La de deposito ya seguia
                "Mercado / Rotulo" y es la que se conserva.
                Una sola tarjeta para los dos flujos: la proxima mejora llega a
                ambos en vez de arreglarse en uno y quedar pendiente en el otro,
                que es como se llego a tener dos. */}
            <div className="space-y-4">
              {merchants.map((merchant, idx) => (
                <MerchantOfferCard
                  key={merchant.seller_id}
                  merchant={merchant}
                  amount={amount}
                  loading={loading}
                  isBest={idx === 0}
                  maxEffectiveFeePercent={maxEffectiveFeePercent}
                  flow="cashout"
                  onChoose={(m) => {
                    if (onProceedToConfirm) {
                      onProceedToConfirm({
                        id: m.seller_id,
                        name: m.username,
                        receiveMxn: m.payout_mxn,
                        clientPaysMxn: m.client_pays_mxn,
                        commissionPct: m.rate_percent,
                        platformFeeMxn: m.platform_fee_mxn,
                        providerFeeMxn: m.provider_fee_mxn,
                        nearbyCount: merchants.length,
                      });
                    } else {
                      onSelectOffer(m.seller_id);
                    }
                  }}
                />
              ))}
            </div>

            {/* Footer Note */}
            <footer className="mt-10 mb-8 p-6 text-center">
              <p className="text-[12px] leading-relaxed text-gris font-medium">
                {t('map.footerNote')}
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
};

// ─── State screens ───────────────────────────────────────────────────────────

function StateHeader({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <header className="border-b-2 border-tinta fixed top-0 left-0 w-full z-50 flex items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel ">
      <button
        onClick={onBack}
        className="min-h-12 min-w-12 flex items-center justify-center p-2 rounded-sm hover:bg-surface-container-low transition-colors duration-200"
        aria-label="Volver"
      >
        <span className="material-symbols-outlined text-verde">arrow_back</span>
      </button>
      <h1 className="ml-4 font-headline font-bold text-xl text-tinta tracking-tight">
        {t('map.title')}
      </h1>
    </header>
  );
}

function StateShell({
  onBack,
  icon,
  title,
  children,
  spin = false,
}: {
  onBack: () => void;
  icon: string;
  title: string;
  children?: ReactNode;
  spin?: boolean;
}) {
  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-screen pb-24">
      <StateHeader onBack={onBack} />
      <main className="pt-[calc(6rem+env(safe-area-inset-top))] px-6 max-w-2xl mx-auto flex flex-col items-center text-center">
        <div className="w-16 h-16 bg-verde-suave rounded-sm flex items-center justify-center mt-16 mb-6">
          <span className={`material-symbols-outlined text-verde text-4xl ${spin ? 'animate-spin' : ''}`}>
            {icon}
          </span>
        </div>
        <h2 className="font-headline font-bold text-xl text-on-surface mb-2">{title}</h2>
        {children}
      </main>
    </div>
  );
}

function LoadingSkeleton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <StateShell onBack={onBack} icon="progress_activity" title={t('map.searchingOffers')} spin>
      <p className="text-sm text-gris font-medium max-w-xs">
        {t('map.locatingAgents')}
      </p>
    </StateShell>
  );
}

function LocationDenied({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <StateShell onBack={onBack} icon="location_off" title={t('map.needLocation')}>
      <p className="text-sm text-gris font-medium max-w-xs mb-6">
        {t('map.enableLocation')}
      </p>
      <button
        onClick={onBack}
        className="px-6 py-3 border border-primary text-verde font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
      >
        {t('map.back')}
      </button>
    </StateShell>
  );
}

function FetchError({
  onBack,
  onRetry,
  detail,
}: {
  onBack: () => void;
  onRetry: () => void;
  detail?: string;
}) {
  const { t } = useTranslation();
  return (
    <StateShell onBack={onBack} icon="cloud_off" title={t('map.couldNotLoad')}>
      {/*
        Este estado agrupa dos causas muy distintas: no se pudo obtener la
        ubicación, o falló la petición al servidor. Culpar siempre a la
        conexión mandó una investigación entera por el camino equivocado el
        2026-09-05, así que cuando el hook sabe qué pasó, se dice.
      */}
      <p className="text-sm text-gris font-medium max-w-xs mb-6">
        {detail || t('map.checkConnection')}
      </p>
      <button
        onClick={onRetry}
        className="px-6 py-3 bg-verde text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
      >
        {t('map.retry')}
      </button>
    </StateShell>
  );
}

function EmptyState({ onBack, amount }: { onBack: () => void; amount: number }) {
  const { t } = useTranslation();
  return (
    <StateShell onBack={onBack} icon="search_off" title={t('map.noAgentsAvailable')}>
      <p className="text-sm text-gris font-medium max-w-xs mb-6">
        {t('map.noAgentsDesc', { amount })}
      </p>
      <button
        onClick={onBack}
        className="px-6 py-3 border border-primary text-verde font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
      >
        {t('map.changeAmount')}
      </button>
    </StateShell>
  );
}

export default ExploreMap;
