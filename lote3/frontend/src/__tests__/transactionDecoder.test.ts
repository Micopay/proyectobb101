import { describe, it, expect } from 'vitest';
import { decodeTransactionXdr } from '../services/transactionDecoder';
import { parsePairingPayload } from '../services/signRequestService';

// XLM Payment XDR (Amount: 12.5 XLM)
const XLM_PAYMENT_XDR = 'AAAAAgAAAABXy3cve9oFuErK98qGktvhwmqnwu1IpxC4fYrw71Xn5wAAAGQAAAAAAAAAZQAAAAEAAAAAAAAAAAAAAABqYgd3AAAAAAAAAAEAAAAAAAAAAQAAAADHUu+CO7gNh3pUZVLm9jFvG7B8dGS8XOukksSlDXrgUgAAAAAAAAAAB3NZQAAAAAAAAAAA';

describe('transactionDecoder', () => {
  it('correctly decodes a valid Stellar native XLM payment transaction XDR fixture', () => {
    const result = decodeTransactionXdr(XLM_PAYMENT_XDR, 'Test SDF Network ; July 2015');

    expect(result.type).toBe('payment');
    if (result.type === 'payment') {
      expect(parseFloat(result.amount)).toBe(12.5);
      expect(result.assetCode).toBe('XLM');
      expect(result.destination).toBe('GDDVF34CHO4A3B32KRSVFZXWGFXRXMD4ORSLYXHLUSJMJJINPLQFFHL5');
    }
  });

  it('handles invalid or corrupted XDR safely by returning unknown with warning key', () => {
    const invalidXdr = 'INVALID_XDR_STRING_12345';
    const result = decodeTransactionXdr(invalidXdr, 'Test SDF Network ; July 2015');

    expect(result.type).toBe('unknown');
    if (result.type === 'unknown') {
      expect(result.warningKey).toBe('signatureApproval.warnings.failedToDecode');
      expect(result.error).toBeDefined();
    }
  });

  it('handles empty string XDR gracefully', () => {
    const result = decodeTransactionXdr('', 'Test SDF Network ; July 2015');

    expect(result.type).toBe('unknown');
    if (result.type === 'unknown') {
      expect(result.warningKey).toBe('signatureApproval.warnings.invalidXdr');
    }
  });
});

describe('parsePairingPayload', () => {
  it('parses deep links with query parameters', () => {
    const url = 'micopay://sign-request?id=req_12345';
    const parsed = parsePairingPayload(url);
    expect(parsed?.requestId).toBe('req_12345');
  });

  it('parses deep links with path id', () => {
    const url = 'micopay://sign-request/req_67890';
    const parsed = parsePairingPayload(url);
    expect(parsed?.requestId).toBe('req_67890');
  });

  it('parses JSON formatted QR strings', () => {
    const jsonStr = JSON.stringify({ requestId: 'req_json_999' });
    const parsed = parsePairingPayload(jsonStr);
    expect(parsed?.requestId).toBe('req_json_999');
  });

  it('parses raw string IDs', () => {
    const raw = 'req_raw_abc123';
    const parsed = parsePairingPayload(raw);
    expect(parsed?.requestId).toBe('req_raw_abc123');
  });

  it('returns null for invalid inputs', () => {
    expect(parsePairingPayload('')).toBeNull();
    expect(parsePairingPayload('   ')).toBeNull();
  });
});
