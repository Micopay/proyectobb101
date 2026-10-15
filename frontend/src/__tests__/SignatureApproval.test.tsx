import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignatureApproval } from '../pages/SignatureApproval';
import * as signRequestService from '../services/signRequestService';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: any) => {
        if (key === 'signatureApproval.externalRequestDesc') return `Request from ${options?.appName}`;
        return key;
      },
    }),
  };
});

const mockXdr = 'AAAAAgAAAABXy3cve9oFuErK98qGktvhwmqnwu1IpxC4fYrw71Xn5wAAAGQAAAAAAAAAZQAAAAEAAAAAAAAAAAAAAABqYgd3AAAAAAAAAAEAAAAAAAAAAQAAAADHUu+CO7gNh3pUZVLm9jFvG7B8dGS8XOukksSlDXrgUgAAAAAAAAAAB3NZQAAAAAAAAAAA';

describe('SignatureApproval Component', () => {
  const sampleRequest: signRequestService.SignatureRequest = {
    id: 'req-123',
    app_name: 'CoffeePay',
    xdr: mockXdr,
    status: 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders pending signature request with decoded details', async () => {
    render(<SignatureApproval initialRequest={sampleRequest} />);

    expect(screen.getByText('CoffeePay')).toBeInTheDocument();
    expect(screen.getByText('Request from CoffeePay')).toBeInTheDocument();
    expect(screen.getByText(/12\.5/)).toBeInTheDocument();
    expect(screen.getByText(/XLM/)).toBeInTheDocument();
    expect(screen.getByText('signatureApproval.approveBtn')).toBeInTheDocument();
    expect(screen.getByText('signatureApproval.rejectBtn')).toBeInTheDocument();
  });

  it('renders clear security warning when XDR fails to decode', async () => {
    const corruptedRequest: signRequestService.SignatureRequest = {
      ...sampleRequest,
      xdr: 'CORRUPTED_XDR',
    };

    render(<SignatureApproval initialRequest={corruptedRequest} />);

    expect(screen.getByText('signatureApproval.warnings.untrustedTitle')).toBeInTheDocument();
    expect(screen.getByText('signatureApproval.warnings.failedToDecode')).toBeInTheDocument();
    const approveBtn = screen.getByText('signatureApproval.approveBtn').closest('button');
    expect(approveBtn).toBeDisabled();
  });

  it('handles approve action and calls resolveSignatureRequest', async () => {
    const resolveSpy = vi.spyOn(signRequestService, 'resolveSignatureRequest').mockResolvedValue({
      id: 'req-123',
      status: 'approved',
      signed_xdr: 'SIGNED_XDR',
    });

    render(<SignatureApproval initialRequest={sampleRequest} />);

    const approveBtn = screen.getByText('signatureApproval.approveBtn');
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith(
        'req-123',
        'approve',
        mockXdr,
        undefined,
        undefined
      );
      expect(screen.getByText('signatureApproval.approvedSuccessTitle')).toBeInTheDocument();
    });
  });

  it('handles reject action and calls resolveSignatureRequest', async () => {
    const resolveSpy = vi.spyOn(signRequestService, 'resolveSignatureRequest').mockResolvedValue({
      id: 'req-123',
      status: 'rejected',
    });

    render(<SignatureApproval initialRequest={sampleRequest} />);

    const rejectBtn = screen.getByText('signatureApproval.rejectBtn');
    fireEvent.click(rejectBtn);

    await waitFor(() => {
      expect(resolveSpy).toHaveBeenCalledWith(
        'req-123',
        'reject',
        undefined,
        undefined,
        undefined
      );
      expect(screen.getByText('signatureApproval.rejectedSuccessTitle')).toBeInTheDocument();
    });
  });

  it('disables approval and shows expired state for expired requests', async () => {
    const expiredRequest: signRequestService.SignatureRequest = {
      ...sampleRequest,
      status: 'expired',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };

    render(<SignatureApproval initialRequest={expiredRequest} />);

    expect(screen.getByText('signatureApproval.statusExpired')).toBeInTheDocument();
    expect(screen.getByText('signatureApproval.dismissExpiredBtn')).toBeInTheDocument();
    expect(screen.queryByText('signatureApproval.approveBtn')).not.toBeInTheDocument();
  });
});
