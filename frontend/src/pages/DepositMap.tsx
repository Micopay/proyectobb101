import MapReal from '../components/MapReal';
import { useTranslation } from 'react-i18next';
import { useMerchantsAvailable } from '../hooks/useMerchantsAvailable';
import {
  effectiveFeePercent,
  MAX_EFFECTIVE_FEE_PERCENT,
  type AvailableMerchant,
} from '../services/api';
import { PLATFORM_FEE_PERCENT } from '../constants/trade';
import ErrorBanner from '../components/ErrorBanner';
import MerchantOfferCard from '../components/MerchantOfferCard';
import type { OfferConfirmData } from './ExploreMap';
import type { ApiErrorAction } from '../utils/apiError';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface DepositMapProps {
  onBack: () => void;
  onSelectOffer: (offerId: string) => void;
  /**
   * Paso de confirmacion, igual que en cash-out. El deposito saltaba directo al
   * chat al elegir agente: sin resumen del monto, la comision y quien es la
   * contraparte. Los dos flujos comprometen dinero y los dos merecen ese paso.
   */
  onProceedToConfirm?: (offer: OfferConfirmData) => void;
  loading?: boolean;
  amount?: number;
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
      <div className="flex items-center justify-between gap-2 border-t border-linea pt-3">
        <span className="text-xs text-on-surface-variant font-label uppercase">
          {t('depositMap.effectiveCost')}
        </span>
        <span className={`text-sm font-bold tabular-nums ${exceeds ? 'text-error' : 'text-on-surface'}`}>
          {totalPct.toFixed(1)}%
        </span>
      </div>
      <p className="text-[11px] text-on-surface-variant">
        {t('depositMap.feeBreakdown', { platformFeePct, commissionPct })}
      </p>
      {exceeds && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-sm border border-error/30 bg-error/5 px-3 py-2"
        >
          <span className="material-symbols-outlined text-error text-base leading-none">warning</span>
          <p className="text-[12px] font-medium text-error leading-snug">
            {t('depositMap.feeExceeded', { maxPct })}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton({ onBack, amount }: { onBack: () => void; amount: number }) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface text-on-surface min-h-screen pb-24">
      <header className="border-b-2 border-tinta w-full top-0 sticky bg-[#E7F6FF] z-50 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <div className="flex items-center gap-4">
            <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 text-verde active:translate-x-[2px] active:translate-y-[2px] duration-200">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <h1 className="font-headline font-bold text-xl text-tinta">{t('depositMap.title')}</h1>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 pt-8 space-y-8" aria-busy="true" aria-label={t('depositMap.loading')}>
        <section className="space-y-2">
          <span className="text-on-surface-variant font-label text-sm uppercase tracking-widest">
            {t('depositMap.request')}
          </span>
          <div className="flex items-baseline gap-2">
            <h2 className="num text-4xl font-headline font-extrabold text-on-surface tracking-tight">{t('depositMap.amount', { amount })}</h2>
            <span className="text-xl font-headline font-bold text-on-surface-variant">{t('depositMap.currency')}</span>
          </div>
          <p className="text-on-surface-variant text-sm font-body">{t('depositMap.locatingAgents')}</p>
        </section>

        <section>
          <div className="w-full h-64 bg-surface-container-low rounded-sm" />
        </section>

        <div className="space-y-6">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="bg-papel rounded-sm border-2 border-tinta shadow-solida p-5 space-y-4"
            >
              <div className="flex gap-4">
                <div className="w-12 h-12 bg-surface-container-high rounded-sm" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-40 bg-surface-container-high rounded" />
                  <div className="h-3 w-24 bg-surface-container-high rounded" />
                </div>
              </div>
              <div className="h-[46px] w-full rounded-sm bg-surface-container-high" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

// ─── Location denied state ────────────────────────────────────────────────────

function LocationDenied({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface text-on-surface min-h-screen pb-24">
      <header className="border-b-2 border-tinta w-full top-0 sticky bg-[#E7F6FF] z-50 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center px-6 py-4">
          <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 text-verde active:translate-x-[2px] active:translate-y-[2px] duration-200">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <h1 className="ml-4 font-headline font-bold text-xl text-tinta">{t('depositMap.title')}</h1>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <span className="material-symbols-outlined text-5xl text-gris">location_off</span>
        <h2 className="font-headline font-bold text-xl text-on-surface">{t('depositMap.locationNeeded')}</h2>
        <p className="text-sm text-gris font-medium max-w-xs leading-snug">
          {t('depositMap.locationDescription')}
        </p>
        <button
          onClick={onBack}
          className="mt-2 px-6 py-3 border-2 border-primary text-verde font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
        >
          {t('depositMap.back')}
        </button>
      </main>
    </div>
  );
}

// ─── Error state ──────────────────────────────────────────────────────────────

function FetchError({ onBack, onRetry }: { onBack: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface text-on-surface min-h-screen pb-24">
      <header className="border-b-2 border-tinta w-full top-0 sticky bg-[#E7F6FF] z-50 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center px-6 py-4">
          <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 text-verde active:translate-x-[2px] active:translate-y-[2px] duration-200">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <h1 className="ml-4 font-headline font-bold text-xl text-tinta">{t('depositMap.title')}</h1>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <span className="material-symbols-outlined text-5xl text-error">wifi_off</span>
        <h2 className="font-headline font-bold text-xl text-on-surface">{t('depositMap.loadError')}</h2>
        <p className="text-sm text-gris font-medium max-w-xs">
          {t('depositMap.checkConnection')}
        </p>
        <div className="flex gap-3 mt-2">
          <button
            onClick={onRetry}
            className="px-6 py-3 bg-verde text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
          >
            {t('depositMap.retry')}
          </button>
          <button
            onClick={onBack}
            className="px-6 py-3 border border-outline text-on-surface font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
          >
            {t('depositMap.back')}
          </button>
        </div>
      </main>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onBack, amount }: { onBack: () => void; amount: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center text-center py-12 px-4 gap-4">
      <div className="w-16 h-16 rounded-sm bg-surface-container-high flex items-center justify-center">
        <span className="material-symbols-outlined text-gris text-3xl">location_off</span>
      </div>
      <h2 className="font-headline font-bold text-xl text-on-surface">{t('depositMap.noAgents')}</h2>
      <p className="text-sm text-gris leading-snug max-w-[280px]">
        {t('depositMap.noAgentsDescription', { amount })}
      </p>
      <button
        onClick={onBack}
        className="mt-2 h-[48px] px-8 border-2 border-primary text-verde font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all duration-200 flex items-center gap-2"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-sm">tune</span>
        {t('depositMap.changeAmount')}
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const DepositMap = ({
  onBack,
  onSelectOffer,
  onProceedToConfirm,
  loading = false,
  amount = 500,
  creationError,
  creationErrorAction = 'retry',
  onDismissCreationError,
  onRetryCreationError,
  maxEffectiveFeePercent = MAX_EFFECTIVE_FEE_PERCENT,
}: DepositMapProps) => {
  const { t } = useTranslation();
  const { state, refetch } = useMerchantsAvailable({
    amount_mxn: amount,
    flow: 'deposit',
    radius_km: 50,
  });

  if (state.status === 'loading' || state.status === 'idle') {
    return <LoadingSkeleton onBack={onBack} amount={amount} />;
  }

  if (state.status === 'location_denied') {
    return <LocationDenied onBack={onBack} />;
  }

  if (state.status === 'error') {
    return <FetchError onBack={onBack} onRetry={refetch} />;
  }

  const merchants = state.status === 'success' ? state.merchants : [];

  return (
    <div className="bg-surface text-on-surface min-h-screen pb-24">
      {/* TopAppBar */}
      <header className="border-b-2 border-tinta w-full top-0 sticky bg-[#E7F6FF] transition-colors duration-300 z-50 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="min-h-12 min-w-12 text-verde active:translate-x-[2px] active:translate-y-[2px] duration-200"
              aria-label={t('a11y.back')}
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <h1 className="font-headline font-bold text-xl text-tinta">{t('depositMap.title')}</h1>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 pt-8 space-y-8">
        {creationError && (
          <ErrorBanner
            message={creationError}
            action={creationErrorAction}
            onRetry={onRetryCreationError}
            onDismiss={onDismissCreationError}
            supportState="TRADE_CREATE"
          />
        )}

        {/* Summary Context */}
        <section className="space-y-2">
          <span className="text-on-surface-variant font-label text-sm uppercase tracking-widest">
            {t('depositMap.request')}
          </span>
          <div className="flex items-baseline gap-2">
            <h2 className="text-4xl font-headline font-extrabold text-on-surface tracking-tight">
              {t('depositMap.amount', { amount })}
            </h2>
            <span className="text-xl font-headline font-bold text-on-surface-variant">{t('depositMap.currency')}</span>
          </div>
          <p className="text-on-surface-variant text-sm font-body">
            {merchants.length > 0
              ? t(
                  merchants.length === 1
                    ? 'depositMap.agentsNearbyOne'
                    : 'depositMap.agentsNearbyMany',
                  { count: merchants.length },
                )
              : t('depositMap.searchingAgents')}
          </p>
        </section>

        {/* Map View Section */}
        <section>
          <MapReal
            type="deposit"
            merchants={merchants}
            userPosition={state.status === 'success' ? state.userPosition : null}
          />
        </section>

        {/* Offers List */}
        {merchants.length === 0 ? (
          <EmptyState onBack={onBack} amount={amount} />
        ) : (
          <div className="space-y-6">
            {merchants.map((merchant, idx) => (
              <MerchantOfferCard
                key={merchant.seller_id}
                merchant={merchant}
                amount={amount}
                loading={loading}
                isBest={idx === 0}
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
                maxEffectiveFeePercent={maxEffectiveFeePercent}
                flow="deposit"
              />
            ))}
          </div>
        )}

        {/* Informative note */}
        <div className="bg-surface-container-low rounded-sm p-6 border border-primary/10">
          <div className="flex gap-4">
            <span className="material-symbols-outlined text-verde">info</span>
            <p className="text-sm text-on-surface-variant leading-relaxed">
              {t('depositMap.infoNote')}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default DepositMap;
