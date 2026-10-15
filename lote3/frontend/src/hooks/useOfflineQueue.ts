import { useState, useEffect, useCallback } from 'react';
import {
  initOfflineQueue,
  queueMutation,
  getPendingMutationCount,
} from '../services/offlineQueue';
import type { MutationType, MutationPayloadMap } from '../services/offlineQueue';
import { flushQueue, initNetworkMonitoring } from '../services/offlineQueueManager';

interface UseOfflineQueueResult {
  queueMutationAsync: <T extends MutationType>(
    type: T,
    payload: MutationPayloadMap[T],
  ) => Promise<string>;
  retryAsync: (token: string | null) => Promise<void>;
  hasPending: boolean;
  isSyncing: boolean;
  isOnline: boolean;
}

export function useOfflineQueue(token: string | null): UseOfflineQueueResult {
  const [hasPending, setHasPending] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    let cancelled = false;
    // initNetworkMonitoring vacía la cola sola al recuperar la conexión. Antes
    // no se llamaba desde ninguna parte, así que las mutaciones encoladas se
    // quedaban en IndexedDB para siempre.
    initOfflineQueue()
      .then(() => {
        if (!cancelled) initNetworkMonitoring(token);
      })
      .catch(() => {});
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [token]);

  const refreshPending = useCallback(() => {
    getPendingMutationCount().then((n) => setHasPending(n > 0)).catch(() => {});
  }, []);

  const queueMutationAsync = useCallback(async <T extends MutationType>(
    type: T,
    payload: MutationPayloadMap[T],
  ): Promise<string> => {
    const id = await queueMutation(type, payload);
    refreshPending();
    return id;
  }, [refreshPending]);

  const retryAsync = useCallback(async (retryToken: string | null) => {
    setIsSyncing(true);
    try {
      // flushQueue envía cada mutación al backend y solo marca como sincronizada
      // la que responde 2xx. La versión anterior marcaba TODO como sincronizado
      // sin llamar a nadie, es decir, descartaba los cambios del comercio
      // mientras la UI le confirmaba que se habían guardado.
      await flushQueue(retryToken ?? token);
      refreshPending();
    } finally {
      setIsSyncing(false);
    }
  }, [refreshPending, token]);

  return { queueMutationAsync, retryAsync, hasPending, isSyncing, isOnline };
}
