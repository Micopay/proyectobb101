/**
 * H5 · "efectivo en mano": el monto que escribe la persona es el efectivo que
 * cambia de mano. En retiro las comisiones van encima de lo que sale del
 * saldo; en deposito se descuentan de lo que llega al saldo.
 *
 * $500 con agente al 1% ($5) y plataforma 0.8% ($4), cifras del servidor:
 *   retiro:   recibes $500 en efectivo, salen $509 de tu saldo
 *   deposito: entregas $500 en efectivo, recibes $491 en tu saldo
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from '../i18n';
import TradeConfirmationPage from '../pages/TradeConfirmation';
import MerchantOfferCard from '../components/MerchantOfferCard';
import type { AvailableMerchant } from '../services/api';

beforeAll(async () => {
  await i18n.changeLanguage('es');
});
afterEach(() => cleanup());

const fetchRate = async () => ({ rate: 18 });

function confirm(flow: 'cashout' | 'deposit', receiveMxn: number, clientPaysMxn: number) {
  render(
    <TradeConfirmationPage
      merchantName="agente_xalapa"
      merchantId="m1"
      receiveMxn={receiveMxn}
      clientPaysMxn={clientPaysMxn}
      commissionPct={1}
      amountMxn={500}
      platformFeeMxn={4}
      providerFeeMxn={5}
      flow={flow}
      nearbyCount={1}
      onBack={() => {}}
      onConfirm={async () => true}
      assetKey="stellar:XLM"
      fetchRate={fetchRate}
    />,
  );
}

describe('TradeConfirmation · efectivo en mano', () => {
  it('retiro: recibes $500 en efectivo y salen $509 de tu saldo', () => {
    confirm('cashout', 500, 509);
    expect(screen.getByText('Recibes en efectivo')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-cash')).toHaveTextContent('$500.00 MXN');
    expect(screen.getByText('Sale de tu saldo')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-balance')).toHaveTextContent('$509.00 MXN');
  });

  it('deposito: entregas $500 en efectivo y recibes $491 en tu saldo', () => {
    confirm('deposit', 491, 500);
    expect(screen.getByText('Entregas en efectivo')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-cash')).toHaveTextContent('$500.00 MXN');
    expect(screen.getByText('Recibes en tu saldo')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-balance')).toHaveTextContent('$491.00 MXN');
  });
});

const MERCHANT: AvailableMerchant = {
  seller_id: 's1',
  username: 'agente_xalapa',
  rate_percent: 1,
  min_trade_mxn: 100,
  max_trade_mxn: 50000,
  daily_cap_mxn: 250000,
  latitude: 19.53,
  longitude: -96.912,
  area_label: 'Xalapa centro',
  storefront_address: null,
  distance_km: 0.142,
  payout_mxn: 500,
  client_pays_mxn: 509,
  provider_fee_mxn: 5,
  platform_fee_mxn: 4,
  effective_fee_percent: 1.8,
};

describe('MerchantOfferCard · efectivo en mano', () => {
  it('retiro: entregas $509 de tu saldo, recibes $500 en efectivo, comision $9', () => {
    render(
      <MerchantOfferCard merchant={MERCHANT} amount={500} loading={false} isBest onChoose={() => {}} flow="cashout" />,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('509.00');
    expect(text).toContain('500.00');
    expect(text).toContain('9.00');
    // Antes la comision salia de `monto - payout`, que en retiro da 0.
    expect(text).not.toMatch(/\$0\.00/);
  });
});
