import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import i18n from '../i18n';
import MerchantInbox from '../pages/MerchantInbox';

vi.mock('../services/api', () => ({
  getMerchantTrades: vi.fn().mockResolvedValue([]),
  merchantConfirmScan: vi.fn(),
  completeTrade: vi.fn(),
}));

vi.mock('../hooks/useQRScanner', () => ({
  useQRScanner: () => ({
    scan: vi.fn(),
  }),
}));

vi.mock('../components/SupportLink', () => ({
  default: () => null,
}));

describe('MerchantInbox i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders translated English copy', async () => {
    render(
      <MerchantInbox
        token="token"
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument());
    expect(screen.getByText('No transactions')).toBeInTheDocument();
  });
});
