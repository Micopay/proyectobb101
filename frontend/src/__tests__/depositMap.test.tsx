import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from '../i18n';
import DepositMap from '../pages/DepositMap';

vi.mock('../hooks/useMerchantsAvailable', () => ({
  useMerchantsAvailable: () => ({
    state: {
      status: 'success',
      merchants: [],
      userPosition: { latitude: 19, longitude: -96 },
    },
    refetch: vi.fn(),
  }),
}));

vi.mock('../components/MapReal', () => ({
  default: () => <div data-testid="map-real" />,
}));

vi.mock('../components/MerchantOfferCard', () => ({
  default: () => <div data-testid="merchant-offer-card" />,
}));

describe('DepositMap i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    cleanup();
  });

  it('renders translated English copy', () => {
    render(
      <DepositMap
        onBack={() => {}}
        onSelectOffer={() => {}}
        amount={500}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Deposit offers' })).toBeInTheDocument();
    expect(screen.getByText('Deposit request')).toBeInTheDocument();
  });
});
