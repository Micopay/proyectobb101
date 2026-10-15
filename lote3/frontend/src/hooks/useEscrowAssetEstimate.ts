import { useEffect, useState } from 'react';
import { getEscrowAssetRate } from '../services/api';

/* Equivalente ESTIMADO de un monto en pesos en el activo del escrow, antes de
   crear la operacion. Lo comparten el selector de la pantalla de monto (WP-C)
   y la confirmacion final (WP-D). La tasa vinculante la congela el servidor al
   crear la operacion; esta nunca se envia.

   La tasa se pide al montar y al cambiar de activo, no por tecla: el
   equivalente se recalcula localmente con el monto. La respuesta de un activo
   que ya no esta seleccionado se descarta. */

/** El monto minimo de una operacion (backend: POST /trades). */
export const MIN_TRADE_AMOUNT_MXN = 100;

export type EscrowEstimate =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rate: number; units: number | null };

export function useEscrowAssetEstimate(
  assetCode: string | null | undefined,
  amountMxn: number | null,
  fetchRate: (code: string) => Promise<{ rate: number }> = getEscrowAssetRate,
): EscrowEstimate {
  const [rate, setRate] = useState<EscrowEstimate>({ status: 'idle' });

  useEffect(() => {
    if (!assetCode) {
      setRate({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setRate({ status: 'loading' });
    fetchRate(assetCode)
      .then((r) => {
        if (cancelled) return;
        setRate(
          Number.isFinite(r.rate) && r.rate > 0
            ? { status: 'ready', rate: r.rate, units: null }
            : { status: 'error' },
        );
      })
      .catch(() => {
        if (!cancelled) setRate({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [assetCode, fetchRate]);

  if (rate.status !== 'ready') return rate;
  const hasAmount = amountMxn !== null && Number.isFinite(amountMxn) && amountMxn >= MIN_TRADE_AMOUNT_MXN;
  return { status: 'ready', rate: rate.rate, units: hasAmount ? amountMxn! / rate.rate : null };
}

export function formatEstimateUnits(value: number, decimals: number, language: string | undefined): string {
  const locale = language?.startsWith('en') ? 'en-US' : 'es-MX';
  return value.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
