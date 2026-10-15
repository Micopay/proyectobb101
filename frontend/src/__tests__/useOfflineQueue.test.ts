/**
 * Regresión del bug central de ISSUE-02 (auditoría 2026-08).
 *
 * `src/__tests__/offlineQueue.test.ts` ejercita `flushQueue`, que ya estaba
 * bien implementado. El defecto vivía aquí, en el hook: `retryAsync` recorría
 * las mutaciones pendientes y llamaba `markAsSynced` directamente, sin pasar
 * por el backend. Las descartaba mientras la UI le confirmaba al comercio que
 * se habían guardado.
 *
 * Va en un archivo aparte porque necesita mockear el manager entero, cosa que
 * chocaría con los tests que precisamente lo ejercitan de verdad.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../services/offlineQueueManager', () => ({
  flushQueue: vi.fn().mockResolvedValue([]),
  initNetworkMonitoring: vi.fn(),
}));

vi.mock('../services/offlineQueue', () => ({
  initOfflineQueue: vi.fn().mockResolvedValue(undefined),
  queueMutation: vi.fn().mockResolvedValue('id_1'),
  getPendingMutationCount: vi.fn().mockResolvedValue(0),
  markAsSynced: vi.fn().mockResolvedValue(undefined),
  getPendingMutations: vi.fn().mockResolvedValue([]),
}));

import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { flushQueue, initNetworkMonitoring } from '../services/offlineQueueManager';
import { markAsSynced, getPendingMutations } from '../services/offlineQueue';

const mockFlushQueue = vi.mocked(flushQueue);
const mockInitNetworkMonitoring = vi.mocked(initNetworkMonitoring);
const mockMarkAsSynced = vi.mocked(markAsSynced);
const mockGetPendingMutations = vi.mocked(getPendingMutations);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useOfflineQueue', () => {
  it('retryAsync envía la cola al backend en vez de marcarla como sincronizada', async () => {
    const { result } = renderHook(() => useOfflineQueue('tok'));

    await act(async () => {
      await result.current.retryAsync('tok');
    });

    expect(mockFlushQueue).toHaveBeenCalledWith('tok');
    // Las dos aserciones que fallarían con la implementación vieja:
    // recorría getPendingMutations() y llamaba markAsSynced() sin enviar nada.
    expect(mockMarkAsSynced).not.toHaveBeenCalled();
    expect(mockGetPendingMutations).not.toHaveBeenCalled();
  });

  it('arranca la sincronización automática al montar, con el token', async () => {
    // Sin esto, las mutaciones encoladas se quedaban en IndexedDB para siempre:
    // initNetworkMonitoring no se llamaba desde ninguna parte de la app.
    renderHook(() => useOfflineQueue('tok'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockInitNetworkMonitoring).toHaveBeenCalledWith('tok');
  });
});
