/**
 * El agente debe poder fijar su ubicación con el permiso que la app declara.
 *
 * Reportado el 2026-10-09 desde el APK: en "Unirse a la Red", "Usar mi
 * ubicación actual" no hacía nada. `useLocationPermission` (la verja que usa
 * MerchantSettings vía useGeolocation) seguía exigiendo el alias `location`,
 * que incluye ACCESS_FINE_LOCATION, retirado del manifiesto en T-19. Ese alias
 * no se concede nunca, así que la ubicación no se pedía aunque el usuario
 * aceptara la aproximada. Mismo fallo que merchantsLocationPermission.test.tsx
 * cubre para el mapa de clientes.
 *
 * Se reproduce el estado real del dispositivo: coarseLocation concedida,
 * location denegada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const checkPermissions = vi.fn();
const requestPermissions = vi.fn();
const getCurrentPosition = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    checkPermissions: (...a: unknown[]) => checkPermissions(...a),
    requestPermissions: (...a: unknown[]) => requestPermissions(...a),
    getCurrentPosition: (...a: unknown[]) => getCurrentPosition(...a),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) },
}));

import { useLocationPermission } from '../hooks/usePermission';
import { useGeolocation } from '../hooks/useGeolocation';

beforeEach(() => {
  checkPermissions.mockReset();
  requestPermissions.mockReset();
  getCurrentPosition.mockReset();
});

describe('useLocationPermission usa coarseLocation', () => {
  it('da por concedido el permiso cuando solo la ubicación aproximada está concedida', async () => {
    checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'granted' });
    const { result } = renderHook(() => useLocationPermission());

    let state: string | undefined;
    await act(async () => { state = await result.current.request(); });

    expect(state).toBe('granted');
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('pide solo coarseLocation cuando aún no se ha preguntado', async () => {
    checkPermissions.mockResolvedValue({ location: 'prompt', coarseLocation: 'prompt' });
    requestPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'granted' });
    const { result } = renderHook(() => useLocationPermission());

    let state: string | undefined;
    await act(async () => { state = await result.current.request(); });

    expect(requestPermissions).toHaveBeenCalledWith({ permissions: ['coarseLocation'] });
    expect(state).toBe('granted');
  });

  it('reporta permanently_denied cuando la aproximada está bloqueada', async () => {
    checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });
    const { result } = renderHook(() => useLocationPermission());

    let state: string | undefined;
    await act(async () => { state = await result.current.check(); });

    expect(state).toBe('permanently_denied');
  });
});

describe('useGeolocation obtiene la posición con la aproximada concedida', () => {
  it('requestPermission termina con coordenadas', async () => {
    checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'granted' });
    getCurrentPosition.mockResolvedValue({ coords: { latitude: 19.5438, longitude: -96.9102 } });
    const { result } = renderHook(() => useGeolocation(false));

    await act(async () => { await result.current.requestPermission(); });

    expect(getCurrentPosition).toHaveBeenCalled();
    expect(result.current.lat).toBe(19.5438);
    expect(result.current.lng).toBe(-96.9102);
  });
});
