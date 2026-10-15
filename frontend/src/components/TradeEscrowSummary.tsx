import { useTranslation } from 'react-i18next';
import { describeEscrowForViewer, escrowViewMessageKey, type EscrowTrade } from '../utils/escrowAmounts';

/* WP-D · la cifra del escrow que le corresponde a quien mira, tras crear la
   operacion. Todo sale de la operacion del servidor; con datos incompletos no
   se pinta nada (ver `describeEscrowForViewer`). */

export interface TradeEscrowSummaryProps {
  trade: EscrowTrade | null | undefined;
  viewerId: string | null | undefined;
  className?: string;
}

export default function TradeEscrowSummary({ trade, viewerId, className = '' }: TradeEscrowSummaryProps) {
  const { t } = useTranslation();
  const view = describeEscrowForViewer(trade, viewerId);
  if (!view) return null;

  return (
    <p className={`num text-[13px] text-gris ${className}`} data-testid="trade-escrow-summary">
      {t(`escrowAsset.${escrowViewMessageKey(view)}`, {
        amount: view.amount,
        fee: view.fee,
        total: view.total,
        code: view.assetCode,
      })}
    </p>
  );
}
