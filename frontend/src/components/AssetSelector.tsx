import { useTranslation } from 'react-i18next';
import {
  ESCROW_ASSET_OPTIONS,
  VISIBLE_ESCROW_ASSET_OPTIONS,
  getEscrowAssetOption,
  type EscrowAssetOption,
} from '../constants/escrowAssets';
import type { TradeFlow } from '../services/api';
import {
  formatEstimateUnits,
  MIN_TRADE_AMOUNT_MXN,
  useEscrowAssetEstimate,
} from '../hooks/useEscrowAssetEstimate';

/* WP-C del plan de selector de activo (docs/PLAN_SELECTOR_ACTIVO_2026-09-14.md).

   Con que activo se respalda la operacion, elegido en la pantalla de monto.
   Lo elige siempre el cliente: en cash-out es lo que entrega; en deposito, lo
   que recibe (ahi bloquea el agente).

   Tres reglas que no son de estilo:

   1. El peso es el numero principal. Aqui solo aparece el equivalente
      ESTIMADO, rotulado como tal (`useEscrowAssetEstimate`).

   2. Las opciones sin escrow son radios nativos con `disabled`. `aria-disabled`
      solo no impide activarlas con teclado.

   3. Un fallo de la tasa oculta el equivalente y lo dice, pero NO bloquea
      continuar: la operacion se puede crear igual y el servidor fija la tasa.

   Sin color por token: en Mercado/Rotulo el color significa digital frente a
   efectivo. El activo se distingue por su codigo. */

export interface AssetSelectorProps {
  flow: TradeFlow;
  /** Monto en pesos tal como esta escrito; null/NaN si no es un numero. */
  amountMxn: number | null;
  /** Clave de `ESCROW_ASSET_OPTIONS`. */
  value: string;
  onChange: (key: string) => void;
  /** Inyectable para pruebas. */
  fetchRate?: (code: string) => Promise<{ rate: number }>;
}

export default function AssetSelector({ flow, amountMxn, value, onChange, fetchRate }: AssetSelectorProps) {
  const { t, i18n } = useTranslation();
  const selected = getEscrowAssetOption(value);
  const estimate = useEscrowAssetEstimate(selected?.enabled ? selected.code : null, amountMxn, fetchRate);

  const title = flow === 'cashout' ? t('escrowAsset.payWith') : t('escrowAsset.receiveIn');
  const hasAmount = amountMxn !== null && Number.isFinite(amountMxn) && amountMxn >= MIN_TRADE_AMOUNT_MXN;

  const renderEstimate = (option: EscrowAssetOption) => {
    if (estimate.status === 'error') {
      return <p className="text-[13px] text-gris" role="status">{t('escrowAsset.rateUnavailable')}</p>;
    }
    if (!hasAmount) return null;
    if (estimate.status !== 'ready' || estimate.units === null) {
      return <p className="text-[13px] text-gris" aria-busy="true">{t('escrowAsset.rateLoading')}</p>;
    }
    return (
      <p className="num text-[13px] text-gris" data-testid="asset-estimate">
        {t('escrowAsset.estimate', {
          units: formatEstimateUnits(estimate.units, option.displayDecimals, i18n.language),
          code: option.code,
          rate: formatEstimateUnits(estimate.rate, 2, i18n.language),
        })}
      </p>
    );
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-bold text-gris">{title}</legend>
      <div className="flex flex-col divide-y-2 divide-tinta rounded-sm border-2 border-tinta bg-papel">
        {VISIBLE_ESCROW_ASSET_OPTIONS.map((option) => {
          const id = `escrow-asset-${option.key.replace(':', '-')}`;
          const checked = option.key === value;
          return (
            <label
              key={option.key}
              htmlFor={id}
              className={`flex min-h-12 items-start gap-3 px-3 py-3 ${
                option.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
              }`}
            >
              <input
                id={id}
                type="radio"
                name="escrow-asset"
                value={option.key}
                checked={checked}
                disabled={!option.enabled}
                onChange={() => option.enabled && onChange(option.key)}
                className="mt-1 h-4 w-4 accent-tinta"
              />
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-bold text-tinta">
                    {option.code} <span className="font-normal text-gris">· {option.networkLabel}</span>
                  </span>
                  {!option.enabled ? (
                    <span className="text-[11px] font-bold uppercase tracking-[.1em] text-gris">
                      {t('escrowAsset.comingSoon')}
                    </span>
                  ) : null}
                </span>
                {checked && option.enabled ? renderEstimate(option) : null}
              </span>
            </label>
          );
        })}
      </div>
      {/* Con la tasa caida, `rateUnavailable` ya dice que se fija al crear. */}
      {selected?.enabled && estimate.status !== 'error' ? (
        <p className="text-[12px] text-gris">{t('escrowAsset.rateLocksOnCreate')}</p>
      ) : null}
    </fieldset>
  );
}
