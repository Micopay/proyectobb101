/**
 * Regresión de la cola offline (auditoría 2026-08, ISSUE-02).
 *
 * El bug original tenía tres capas:
 *   1. `retryAsync` marcaba cada mutación pendiente como sincronizada SIN
 *      llamar al backend, es decir, las descartaba mientras la UI le decía al
 *      comercio que se habían guardado.
 *   2. El sincronizador usaba `fetch` con ruta relativa, que en el WebView de
 *      Capacitor resuelve contra la propia app y nunca llega al backend.
 *   3. Lo que se encolaba no tenía la forma que el sincronizador leía:
 *      se guardaba `{ available }` y se leía `payload.merchant_available`.
 *
 * El tercer test es el importante: comprueba que un error del servidor NO se
 * traga como si fuera un éxito. Es la condición que permitía la pérdida de
 * datos silenciosa.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/api', () => ({
  updateMerchantConfig: vi.fn(),
  patchMerchantAvailability: vi.fn(),
}));

vi.mock('../services/offlineQueue.js', () => ({
  getPendingMutations: vi.fn(),
  markAsSynced: vi.fn().mockResolvedValue(undefined),
  markWithError: vi.fn().mockResolvedValue(undefined),
  removeMutation: vi.fn().mockResolvedValue(undefined),
  hasPendingMutations: vi.fn().mockResolvedValue(false),
}));

import { flushQueue } from '../services/offlineQueueManager';
import { updateMerchantConfig, patchMerchantAvailability } from '../services/api';
import {
  getPendingMutations,
  markAsSynced,
  markWithError,
} from '../services/offlineQueue.js';

const mockUpdateConfig = vi.mocked(updateMerchantConfig);
const mockPatchAvailability = vi.mocked(patchMerchantAvailability);
const mockGetPending = vi.mocked(getPendingMutations);
const mockMarkAsSynced = vi.mocked(markAsSynced);
const mockMarkWithError = vi.mocked(markWithError);

const CONFIG = {
  rate_percent: 3,
  min_trade_mxn: 100,
  max_trade_mxn: 5000,
  daily_cap_mxn: 20000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** flushQueue espera 100ms entre mutaciones; hay que dejar correr el reloj. */
async function runFlush(token: string | null) {
  const promise = flushQueue(token);
  await vi.runAllTimersAsync();
  return promise;
}

describe('cola offline — sincronización', () => {
  it('envía una mutación de config al backend con el payload plano', async () => {
    mockGetPending.mockResolvedValue([
      { id: 'config_1', type: 'config', payload: { config: CONFIG }, timestamp: 1, synced: false },
    ] as any);
    mockUpdateConfig.mockResolvedValue(CONFIG as any);

    const results = await runFlush('tok');

    // Antes no se llamaba a nadie: se marcaba como sincronizado y ya.
    expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
    expect(mockUpdateConfig).toHaveBeenCalledWith('tok', CONFIG);
    expect(mockMarkAsSynced).toHaveBeenCalledWith('config_1');
    expect(results[0].success).toBe(true);
  });

  it('envía una mutación de availability leyendo merchant_available', async () => {
    mockGetPending.mockResolvedValue([
      {
        id: 'avail_1',
        type: 'availability',
        payload: { merchant_available: false },
        timestamp: 1,
        synced: false,
      },
    ] as any);
    mockPatchAvailability.mockResolvedValue({ merchant_available: false } as any);

    await runFlush('tok');

    // El contrato roto encolaba `{ available }`, así que esto llegaba como
    // `undefined` y el backend recibía basura.
    expect(mockPatchAvailability).toHaveBeenCalledWith('tok', false);
    expect(mockMarkAsSynced).toHaveBeenCalledWith('avail_1');
  });

  it('NO marca como sincronizada una mutación que el servidor rechaza', async () => {
    mockGetPending.mockResolvedValue([
      { id: 'config_2', type: 'config', payload: { config: CONFIG }, timestamp: 1, synced: false },
    ] as any);
    const serverError: any = new Error('Bad Request');
    serverError.response = { status: 400, data: { message: 'daily_cap_mxn inválido' } };
    mockUpdateConfig.mockRejectedValue(serverError);

    const results = await runFlush('tok');

    expect(mockMarkAsSynced).not.toHaveBeenCalled();
    expect(mockMarkWithError).toHaveBeenCalledWith('config_2', expect.any(String));
    expect(results[0].success).toBe(false);
  });
});
