import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTradePolling } from './useTradePolling';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  getTrade: vi.fn(),
}));

describe('useTradePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls the API and updates trade data', async () => {
    const mockTrade1 = { id: '1', status: 'pending', secret_hash: 'abc', amount_mxn: 100 };
    const mockTrade2 = { id: '1', status: 'locked', secret_hash: 'abc', amount_mxn: 100 };

    const getTradeMock = vi.mocked(api.getTrade);
    getTradeMock.mockResolvedValueOnce(mockTrade1).mockResolvedValueOnce(mockTrade2);

    const { result, unmount } = renderHook(() => useTradePolling('1', 'token123', null, 5000));

    expect(result.current.trade).toBeNull();
    
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(getTradeMock).toHaveBeenCalledTimes(1);
    expect(result.current.trade).toEqual(mockTrade1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getTradeMock).toHaveBeenCalledTimes(2);
    expect(result.current.trade).toEqual(mockTrade2);
    unmount();
  });

  it('stops polling when trade reaches terminal state', async () => {
    const mockTradeCompleted = { id: '1', status: 'completed', secret_hash: 'abc', amount_mxn: 100 };
    
    const getTradeMock = vi.mocked(api.getTrade);
    getTradeMock.mockResolvedValue(mockTradeCompleted);

    const { result, unmount } = renderHook(() => useTradePolling('1', 'token123', null, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.trade?.status).toBe('completed');
    expect(getTradeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(getTradeMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('triggers degraded state after 3 consecutive failures', async () => {
    const getTradeMock = vi.mocked(api.getTrade);
    getTradeMock.mockRejectedValue(new Error('Network error'));

    const { result, unmount } = renderHook(() => useTradePolling('1', 'token123', null, 5000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.isDegraded).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.isDegraded).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.isDegraded).toBe(true);

    const mockTrade = { id: '1', status: 'pending', secret_hash: 'abc', amount_mxn: 100 };
    getTradeMock.mockResolvedValueOnce(mockTrade);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    
    expect(result.current.isDegraded).toBe(false);
    expect(result.current.trade).toEqual(mockTrade);
    unmount();
  });
});
