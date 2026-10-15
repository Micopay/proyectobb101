/**
 * WP-D · activo y cifras reales despues de elegir activo.
 *
 * D9 del plan: el contrato bloquea `amount + platform_fee`. Quien bloquea ve el
 * total con la comision dentro; quien recibe, el monto. "En garantia" solo con
 * evidencia de bloqueo y sin liberar. Todo con datos del servidor, y sin
 * metadatos no se pinta activo.
 *
 * Tambien fija que la pantalla de exito ya no descarta el detalle del servidor
 * para pintar un objeto local con 1%/0.8%, que la confirmacion final muestra el
 * activo, y que QR y detalle leen la operacion del servidor.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from '../i18n';
import { describeEscrowForViewer, formatStroops, shouldKeepPollingTrade } from '../utils/escrowAmounts';
import TradeEscrowSummary from '../components/TradeEscrowSummary';
import SuccessScreen, { receiptFromServer } from '../pages/SuccessScreen';
import TradeConfirmationPage from '../pages/TradeConfirmation';

beforeAll(async () => {
  await i18n.changeLanguage('es');
});

const CLIENT = 'client-1';
const AGENT = 'agent-1';

// 500 MXN a 3.2632550 con comision de 4 MXN (cifras reales de WP-A).
const XLM_TRADE = {
  id: 'trade-1',
  secret_hash: 'h',
  amount_mxn: 500,
  asset_code: 'XLM',
  rate_mxn: '3.2632550',
  amount_stroops: '1532267000',
  platform_fee_stroops: '12257700',
  total_locked_stroops: '1544524700',
  lock_tx_hash: null as string | null,
  release_tx_hash: null as string | null,
};

/** Cash-out: el cliente bloquea (seller) y el agente recibe (buyer). */
const cashout = (patch: Record<string, unknown>) =>
  ({ ...XLM_TRADE, status: 'pending', seller_id: CLIENT, buyer_id: AGENT, ...patch }) as any;
/** Deposito: el agente bloquea (seller) y el cliente recibe (buyer). */
const deposit = (patch: Record<string, unknown>) =>
  ({ ...XLM_TRADE, status: 'pending', seller_id: AGENT, buyer_id: CLIENT, ...patch }) as any;

describe('formatStroops', () => {
  it.each([
    ['1532267000', '153.2267'],
    ['1544524700', '154.45247'],
    ['1000000000', '100.00'],
    ['12257700', '1.22577'],
    ['1', '0.0000001'],
    ['0', '0.00'],
  ])('%s -> %s', (stroops, expected) => {
    expect(formatStroops(stroops)).toBe(expected);
  });

  it.each(['-1', '1.5', 'abc', ''])('rejects %p', (bad) => {
    expect(() => formatStroops(bad)).toThrow();
  });
});

describe('describeEscrowForViewer', () => {
  const phase = (trade: any, viewer: string) => {
    const v = describeEscrowForViewer(trade, viewer);
    return v ? `${v.role}:${v.phase}` : null;
  };

  it.each([
    ['pending, no lock', { status: 'pending' }, 'locker:toLock', 'receiver:toLock'],
    ['pending with lock hash (stale status)', { status: 'pending', lock_tx_hash: 'tx' }, 'locker:inEscrow', 'receiver:inEscrow'],
    ['locked', { status: 'locked', lock_tx_hash: 'tx' }, 'locker:inEscrow', 'receiver:inEscrow'],
    ['revealing', { status: 'revealing', lock_tx_hash: 'tx' }, 'locker:inEscrow', 'receiver:inEscrow'],
    ['completed', { status: 'completed', lock_tx_hash: 'tx', release_tx_hash: 'rx' }, 'locker:released', 'receiver:released'],
    ['cancelled with funds inside', { status: 'cancelled', lock_tx_hash: 'tx' }, 'locker:inEscrow', null],
    ['cancelled before lock', { status: 'cancelled' }, null, null],
    ['expired with funds inside', { status: 'expired', lock_tx_hash: 'tx' }, 'locker:inEscrow', null],
    ['refunded', { status: 'refunded', lock_tx_hash: 'tx' }, 'locker:refunded', null],
  ])('%s', (_label, patch, lockerView, receiverView) => {
    expect(phase(cashout(patch), CLIENT)).toBe(lockerView);
    expect(phase(cashout(patch), AGENT)).toBe(receiverView);
    // En deposito los papeles se invierten con las mismas reglas.
    expect(phase(deposit(patch), AGENT)).toBe(lockerView);
    expect(phase(deposit(patch), CLIENT)).toBe(receiverView);
  });

  it('never guesses: missing asset metadata, a stranger or no viewer -> null', () => {
    for (const k of ['asset_code', 'amount_stroops', 'platform_fee_stroops', 'total_locked_stroops']) {
      expect(describeEscrowForViewer(cashout({ status: 'locked', [k]: undefined }), CLIENT)).toBeNull();
    }
    expect(describeEscrowForViewer(cashout({ status: 'locked' }), 'stranger')).toBeNull();
    expect(describeEscrowForViewer(cashout({ status: 'locked' }), null)).toBeNull();
    expect(describeEscrowForViewer(null, CLIENT)).toBeNull();
  });
});

describe('shouldKeepPollingTrade (H2)', () => {
  it.each([
    ['pending', { status: 'pending' }, true],
    ['locked', { status: 'locked', lock_tx_hash: 'tx' }, true],
    ['revealing', { status: 'revealing', lock_tx_hash: 'tx' }, true],
    ['cancelled with funds inside', { status: 'cancelled', lock_tx_hash: 'tx' }, true],
    ['expired with funds inside', { status: 'expired', lock_tx_hash: 'tx' }, true],
    ['cancelled before lock', { status: 'cancelled' }, false],
    ['cancelled already settled', { status: 'cancelled', lock_tx_hash: 'tx', release_tx_hash: 'rx' }, false],
    ['completed', { status: 'completed', lock_tx_hash: 'tx', release_tx_hash: 'rx' }, false],
    ['refunded', { status: 'refunded', lock_tx_hash: 'tx', release_tx_hash: 'rx' }, false],
  ])('%s -> %s', (_label, patch, expected) => {
    expect(shouldKeepPollingTrade(cashout(patch))).toBe(expected);
  });
});

describe('TradeEscrowSummary', () => {
  it('cash-out client with funds locked sees the TOTAL including the fee', () => {
    render(<TradeEscrowSummary trade={cashout({ status: 'locked', lock_tx_hash: 'tx' })} viewerId={CLIENT} />);
    expect(screen.getByTestId('trade-escrow-summary').textContent).toBe(
      'En garantía: 154.45247 XLM (incluye 1.22577 XLM de comisión).',
    );
  });

  it('deposit client sees what they will receive, not the agent total', () => {
    render(<TradeEscrowSummary trade={deposit({ status: 'locked', lock_tx_hash: 'tx' })} viewerId={CLIENT} />);
    const text = screen.getByTestId('trade-escrow-summary').textContent!;
    expect(text).toBe('Vas a recibir 153.2267 XLM.');
    expect(text).not.toContain('154.45247');
  });

  it('pending does not claim anything is in escrow', () => {
    render(<TradeEscrowSummary trade={cashout({ status: 'pending' })} viewerId={CLIENT} />);
    const text = screen.getByTestId('trade-escrow-summary').textContent!;
    expect(text).toBe('Vas a bloquear 154.45247 XLM (incluye 1.22577 XLM de comisión).');
    expect(text).not.toMatch(/garantía/);
  });

  it('completed does not say "en garantía"', () => {
    render(<TradeEscrowSummary trade={cashout({ status: 'completed', lock_tx_hash: 'tx', release_tx_hash: 'rx' })} viewerId={CLIENT} />);
    expect(screen.getByTestId('trade-escrow-summary').textContent).not.toMatch(/garantía/);
  });

  it('renders nothing for an old response without asset metadata', () => {
    const { container } = render(
      <TradeEscrowSummary trade={cashout({ status: 'locked', asset_code: undefined })} viewerId={CLIENT} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SuccessScreen', () => {
  const serverTrade = {
    ...cashout({ status: 'completed', lock_tx_hash: 'tx', release_tx_hash: 'rx' }),
    platform_fee_mxn: 4,
    provider_fee_mxn: 8,
    payout_mxn: 488,
    created_at: '2026-09-14T10:00:00Z',
    completed_at: '2026-09-14T10:20:00Z',
  };

  it('shows the server payout and both fees, not local percentages', () => {
    render(
      <SuccessScreen type="cashout" trade={receiptFromServer(serverTrade, null, null)} viewerId={CLIENT} agentName="agente_real" onHome={() => {}} />,
    );
    expect(screen.getByText('$488.00')).toBeInTheDocument();
    expect(screen.getByText('-$12.00')).toBeInTheDocument();
    expect(screen.getByTestId('trade-escrow-summary').textContent).toContain('153.2267 XLM');
    expect(screen.getAllByText('agente_real').length).toBeGreaterThan(0);
  });

  it('hides fee and payout when the server did not send them, and invents no agent', () => {
    const bare = receiptFromServer({ ...XLM_TRADE, status: 'completed' } as any, null, null);
    expect(bare.platform_fee_mxn).toBeNull();
    expect(bare.created_at).toBeNull();
    render(<SuccessScreen type="deposit" trade={bare} viewerId={CLIENT} agentName={null} onHome={() => {}} />);
    expect(screen.queryByText('Comisión')).toBeNull();
    expect(screen.queryByText(/Farmacia|Don Pepe/)).toBeNull();
    expect(screen.queryByText(/¿Cómo estuvo el servicio/)).toBeNull();
  });
});

describe('TradeConfirmationPage', () => {
  it('shows the chosen asset and a labeled estimate', async () => {
    render(
      <TradeConfirmationPage
        merchantName="agente"
        merchantId="m1"
        receiveMxn={488}
        commissionPct={1.5}
        amountMxn={500}
        platformFeeMxn={4}
        providerFeeMxn={8}
        flow="cashout"
        nearbyCount={1}
        onBack={() => {}}
        onConfirm={async () => true}
        assetKey="stellar:XLM"
        fetchRate={async () => ({ rate: 3.263255 })}
      />,
    );
    expect(screen.getByText('XLM · Stellar')).toBeInTheDocument();
    expect((await screen.findByTestId('confirm-asset-estimate')).textContent).toBe('≈ 153.22 XLM · 1 XLM = $3.26');
    expect(screen.getByText('Estimado. La tasa se fija al crear la operación.')).toBeInTheDocument();
  });
});

describe('wiring to server data', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(resolve(dir, p), 'utf8');
  const app = read('../App.tsx');
  const route = (name: string) => {
    const start = app.indexOf(`function ${name}`);
    return app.slice(start, app.indexOf('\nfunction ', start + 10));
  };

  it('SuccessRoute passes the server receipt, without local fee percentages', () => {
    const body = route('SuccessRoute');
    expect(body).toContain('receiptFromServer(trade, lockTxHash, releaseTxHash)');
    expect(body).not.toMatch(/0\.01|0\.008|activeAmount/);
    expect(body).not.toMatch(/Farmacia|Don Pepe/);
  });

  it('the success agent is the provider, not the escrow seller', () => {
    expect(route('SuccessRoute')).toContain('trade.provider_id === trade.seller_id ? seller_username : buyer_username');
  });

  it('QRReveal no longer receives the local amount', () => {
    expect(route('QRRevealRoute')).not.toContain('activeAmount');
    expect(read('../pages/QRReveal.tsx')).toContain('displayTrade.amount_mxn');
  });

  it('the final confirmation receives the selected asset', () => {
    expect(route('ConfirmRoute')).toContain('assetKey={activeAssetKey}');
  });

  it.each([
    ['../pages/TradeDetail.tsx', 'viewerId={userId}'],
    ['../pages/ChatRoom.tsx', 'viewerId={userId}'],
    ['../pages/DepositChat.tsx', 'viewerId={userId}'],
    ['../pages/QRReveal.tsx', 'viewerId={viewerId}'],
    ['../pages/SuccessScreen.tsx', 'viewerId={viewerId}'],
  ])('%s renders the escrow summary for the viewer', (file, prop) => {
    const src = read(file);
    expect(src).toContain('<TradeEscrowSummary');
    expect(src).toContain(prop);
  });
});
