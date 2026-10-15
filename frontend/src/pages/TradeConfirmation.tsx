import { useTranslation } from 'react-i18next';
import {
  PLATFORM_FEE_PERCENT,
  platformFeeMxnFromAmount,
} from '../constants/trade';
import { effectiveFeePercent, MAX_EFFECTIVE_FEE_PERCENT } from '../services/api';
import { getEscrowAssetOption } from '../constants/escrowAssets';
import { formatEstimateUnits, useEscrowAssetEstimate } from '../hooks/useEscrowAssetEstimate';

export interface TradeConfirmationPageProps {
  merchantName: string;
  merchantId: string;
  /** Lo que recibe el cliente: efectivo en retiro, saldo en deposito (servidor). */
  receiveMxn: number;
  /**
   * H5: lo que le cuesta al cliente, calculado por el servidor. En retiro es lo
   * que sale de su saldo (monto + comisiones); en deposito, los billetes.
   */
  clientPaysMxn?: number;
  commissionPct: number;
  /** El efectivo que cambia de mano: lo que la persona escribio. */
  amountMxn: number;
  /**
   * Desglose calculado por el servidor. Llega entero para que la pantalla no
   * tenga que deducir ninguna parte restando, que es como se colo el error de
   * que el agente cobrara menos de lo que configuraba.
   */
  platformFeeMxn?: number;
  providerFeeMxn?: number;
  flow: 'cashout' | 'deposit';
  nearbyCount: number;
  onBack: () => void;
  onConfirm: () => Promise<boolean>;
  loading?: boolean;
  errorMessage?: string | null;
  /** Effective-fee threshold (%) above which a warning is shown. Defaults to the shared guardrail. */
  maxEffectiveFeePercent?: number;
  /**
   * WP-D: clave del activo elegido en la pantalla de monto. La operacion aun no
   * existe, asi que lo que se muestra es un ESTIMADO rotulado como tal.
   */
  assetKey?: string;
  /** Inyectable para pruebas. */
  fetchRate?: (code: string) => Promise<{ rate: number }>;
}

export default function TradeConfirmationPage({
  merchantName,
  receiveMxn,
  clientPaysMxn,
  commissionPct,
  amountMxn,
  platformFeeMxn,
  providerFeeMxn,
  flow,
  nearbyCount,
  onBack,
  onConfirm,
  loading = false,
  errorMessage,
  maxEffectiveFeePercent = MAX_EFFECTIVE_FEE_PERCENT,
  assetKey,
  fetchRate,
}: TradeConfirmationPageProps) {
  const { t, i18n } = useTranslation();
  const asset = assetKey ? getEscrowAssetOption(assetKey) : undefined;
  // H5: el monto escrito es el efectivo. En retiro las comisiones van encima
  // (sale de tu saldo `clientPays`); en deposito se descuentan (recibes
  // `receiveMxn` en tu saldo). El estimado en el activo es de lo que se mueve
  // en tu saldo, no del efectivo.
  const isCashout = flow === 'cashout';
  const clientPays = clientPaysMxn ?? (isCashout ? null : amountMxn);
  const balanceMxn = isCashout ? clientPays : receiveMxn;
  const estimate = useEscrowAssetEstimate(asset?.enabled ? asset.code : null, balanceMxn ?? amountMxn, fetchRate);
  // Antes la parte del agente se DEDUCIA restando: `receiveMxn` venia del
  // descubrimiento descontando solo la tarifa del agente, y a ese total se le
  // restaba la comision de plataforma. Resultado: un agente al 1.5% aparecia
  // cobrando 0.7%, y el cliente veia un neto que la operacion no cumplia.
  //
  // Ahora las tres cifras llegan del servidor, que es quien las congela en la
  // operacion. Si no vinieran (build antiguo), se recalculan con la misma
  // formula en vez de deducirlas restando.
  const platformFee = platformFeeMxn ?? platformFeeMxnFromAmount(amountMxn);
  const providerFee = providerFeeMxn ?? Math.ceil((amountMxn * commissionPct) / 100);
  const totalFee = providerFee + platformFee;
  // Combined effective cost the user actually pays: provider commission + platform fee.
  const effectivePct = effectiveFeePercent(commissionPct);
  const exceedsThreshold = effectivePct > maxEffectiveFeePercent;

  const title = flow === 'cashout' ? t('confirm.cashoutTitle') : t('confirm.depositTitle');
  const agentType = flow === 'cashout' ? t('confirm.cashoutAgentType') : t('confirm.depositAgentType');

  return (
    <div className="min-h-screen bg-surface-container-lowest text-on-surface font-body pb-28">
      <header className="sticky top-0 z-40 border-b-2 border-tinta bg-surface/90 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-12 min-w-12 p-2 rounded-sm hover:bg-surface-container-low text-verde transition-colors"
          aria-label="Volver al mapa"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <h1 className="font-headline font-bold text-lg text-tinta truncate">{title}</h1>
      </header>

      <main className="max-w-md mx-auto px-4 pt-6 space-y-5">
        {errorMessage ? (
          <div
            className="rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : null}

        <section className="rounded-sm border-2 border-tinta bg-surface p-5 space-y-4 ">
          <h2 className="text-xs font-bold tracking-widest text-on-surface-variant uppercase">
            {t('confirm.summary')}
          </h2>

          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-on-surface-variant">{t('confirm.agent')}</dt>
              <dd className="font-semibold text-right">{merchantName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-on-surface-variant">{t('confirm.type')}</dt>
              <dd className="font-semibold text-right">{agentType}</dd>
            </div>

            {asset ? (
              <div className="flex justify-between gap-4">
                <dt className="text-on-surface-variant">{t('escrowAsset.selectedAsset')}</dt>
                <dd className="text-right">
                  <span className="font-semibold">{asset.code} · {asset.networkLabel}</span>
                  {estimate.status === 'ready' && estimate.units !== null ? (
                    <span className="num block text-xs text-on-surface-variant" data-testid="confirm-asset-estimate">
                      {t('escrowAsset.estimate', {
                        units: formatEstimateUnits(estimate.units, asset.displayDecimals, i18n.language),
                        code: asset.code,
                        rate: formatEstimateUnits(estimate.rate, 2, i18n.language),
                      })}
                    </span>
                  ) : null}
                  <span className="block text-xs text-on-surface-variant">
                    {estimate.status === 'error' ? t('escrowAsset.rateUnavailable') : t('escrowAsset.rateLocksOnCreate')}
                  </span>
                </dd>
              </div>
            ) : null}

            <div className="flex justify-between gap-4 border-t border-linea pt-3">
              <dt className="text-on-surface-variant">{isCashout ? t('confirm.cashReceived') : t('confirm.cashGiven')}</dt>
              <dd className="font-bold text-lg text-verde" data-testid="confirm-cash">
                ${(isCashout ? receiveMxn : amountMxn).toFixed(2)} MXN
              </dd>
            </div>
            {balanceMxn !== null ? (
              <div className="flex justify-between gap-4">
                <dt className="text-on-surface-variant">{isCashout ? t('confirm.balanceDebited') : t('confirm.balanceReceived')}</dt>
                <dd className="font-semibold text-right" data-testid="confirm-balance">
                  ${balanceMxn.toFixed(2)} MXN
                </dd>
              </div>
            ) : null}

            <div className="flex justify-between gap-4">
              <dt className="num text-on-surface-variant">{t('confirm.totalFee')}</dt>
              <dd className="num font-semibold tabular-nums">${totalFee.toFixed(2)} MXN</dd>
            </div>

            <div className="text-xs text-on-surface-variant pl-2 border-l-2 border-linea ml-1 space-y-1">
              <div className="flex justify-between">
                <span>{t('confirm.agentCommission', { pct: commissionPct })}</span>
                <span>${providerFee.toFixed(2)} MXN</span>
              </div>
              <div className="flex justify-between">
                <span>{t('confirm.platformCommission', { pct: PLATFORM_FEE_PERCENT })}</span>
                <span>${platformFee.toFixed(2)} MXN</span>
              </div>
            </div>

            <div className="flex justify-between gap-4 border-t border-linea pt-3">
              <dt className="num text-on-surface-variant">{t('confirm.totalEffectiveCost')}</dt>
              <dd
                className={`font-bold tabular-nums ${exceedsThreshold ? 'text-error' : 'text-on-surface'}`}
              >
                {effectivePct.toFixed(1)}%
              </dd>
            </div>

            <div className="flex justify-between gap-4">
              <dt className="text-on-surface-variant">{t('confirm.nearbyProviders')}</dt>
              <dd className="font-medium">
                {nearbyCount} {t('confirm.available')}{nearbyCount !== 1 ? 's' : ''}
              </dd>
            </div>
          </dl>
        </section>

        {exceedsThreshold && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-sm border border-error/30 bg-error/5 px-4 py-3"
          >
            <span className="material-symbols-outlined text-error text-base leading-none">warning</span>
            <p className="text-sm font-medium text-error leading-snug">
              {t('confirm.exceedsWarning', { pct: effectivePct.toFixed(1), maxPct: maxEffectiveFeePercent })}
            </p>
          </div>
        )}

        <button
          type="button"
          disabled={loading}
          onClick={async () => { await onConfirm(); }}
          className="w-full rounded-sm bg-verde py-3.5 text-sm font-semibold text-on-primary hover:opacity-95 disabled:opacity-50 transition-opacity"
        >
          {loading ? t('confirm.creating') : t('confirm.confirmBtn')}
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={onBack}
          className="w-full rounded-sm border-2 border-tinta py-3.5 text-sm font-semibold text-on-surface hover:bg-surface-container-low transition-colors"
        >
          {t('confirm.cancel')}
        </button>
      </main>
    </div>
  );
}
