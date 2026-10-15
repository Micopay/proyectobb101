import { useState, useEffect, useCallback, useRef } from 'react';
import { getTrade, TradeData } from '../services/api';

type TradeStatus = 'pending' | 'locked' | 'revealing' | 'completed' | 'cancelled' | 'expired' | 'refunded' | string;

const TERMINAL_STATES = ['completed', 'cancelled', 'expired', 'refunded'];

interface UseTradePollingResult {
  trade: TradeData | null;
  isDegraded: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useTradePolling(
  tradeId: string | undefined,
  token: string | undefined | null,
  initialTrade: TradeData | null = null,
  intervalMs = 5000
): UseTradePollingResult {
  // Note: This hook does not currently deduplicate network calls across multiple tabs.
  // If the same trade is opened in two tabs, both will poll the backend.
  // Implementing exact dedup (e.g. using BroadcastChannel, SharedWorker, or localStorage locks)
  // is considered out of scope for this implementation.
  const [trade, setTrade] = useState<TradeData | null>(initialTrade);
  const [isDegraded, setIsDegraded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  const failCountRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Sync initial trade if it changes from outside
  useEffect(() => {
    if (initialTrade && initialTrade.id === tradeId) {
      setTrade(initialTrade);
    }
  }, [initialTrade, tradeId]);

  const fetchTrade = useCallback(async () => {
    if (!tradeId || !token) return;
    
    try {
      const data = await getTrade(tradeId, token);
      setTrade(data);
      setError(null);
      
      if (failCountRef.current >= 3) {
        setIsDegraded(false);
      }
      failCountRef.current = 0;
      
      return data;
    } catch (err: unknown) {
      failCountRef.current += 1;
      if (failCountRef.current >= 3) {
        setIsDegraded(true);
      }
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, [tradeId, token]);

  useEffect(() => {
    if (!tradeId || !token) {
      return;
    }

    // Stop polling if we reach a terminal state
    if (trade && TERMINAL_STATES.includes(trade.status)) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }

    // Only fetch immediately if we have NO trade data yet
    if (!trade) {
      fetchTrade().catch(() => {
        // Errors are handled in fetchTrade
      });
    }

    pollingRef.current = setInterval(() => {
      fetchTrade().catch(() => {
        // Errors are handled in fetchTrade
      });
    }, intervalMs);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [tradeId, token, trade?.status, fetchTrade, intervalMs, trade]);

  return {
    trade,
    isDegraded,
    error,
    refetch: async () => {
      try {
        await fetchTrade();
      } catch (e) {
        // Ignore
      }
    }
  };
}
