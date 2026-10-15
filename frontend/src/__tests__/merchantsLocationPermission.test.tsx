/**
 * El descubrimiento de agentes debe pedir el permiso que la app realmente tiene.
 *
 * Regresión encontrada probando el APK en un Redmi el 2026-09-05: la pantalla
 * de ofertas mostraba "No pudimos cargar las ofertas / revisa tu conexión" y en
 * los registros del servidor NO aparecía ni una llamada a /merchants/available.
 * No era la red: la petición nunca llegaba a salir.
 *
 * Causa: el plugin define dos alias de permiso —
 *   `location`       = ACCESS_COARSE_LOCATION + ACCESS_FINE_LOCATION
 *   `coarseLocation` = solo ACCESS_COARSE_LOCATION
 * T-19 (faff4b2) retiró FINE del manifiesto, pero esta verja siguió exigiendo
 * el alias `location`. Un alias que incluye un permiso no declarado no puede
 * concederse nunca, así que el mapa quedó muerto en el dispositivo aunque el
 * usuario tuviera la ubicación aproximada concedida.
 *
 * El estado del dispositivo real se reproduce literalmente aquí:
 * coarseLocation concedida, location denegada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const checkPermissions = vi.fn();
const requestPermissions = vi.fn();
const getCurrentPosition = vi.fn();
const getMerchantsAvailable = vi.fn();

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
vi.mock('../services/api', () => ({
  getMerchantsAvailable: (...a: unknown[]) => getMerchantsAvailable(...a),
}));

import { useMerchantsAvailable } from '../hooks/useMerchantsAvailable';

/** Exactamente lo que reporta el Redmi tras T-19. */
const DEVICE_AFTER_T19 = { location: 'denied', coarseLocation: 'granted' };

const POSITION = { coords: { latitude: 19.110586, longitude: -96.939476 } };

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentPosition.mockResolvedValue(POSITION);
  getMerchantsAvailable.mockResolvedValue([{ seller_id: 'm1' }]);
});

const render = () =>
  renderHook(() => useMerchantsAvailable({ amount_mxn: 500, radius_km: 5 }));

describe('permiso de ubicación del descubrimiento', () => {
  it('carga las ofertas con solo la ubicación aproximada concedida', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);

    const { result } = render();

    // Lo que de verdad estaba roto: la petición ni siquiera salía.
    await waitFor(() => expect(getMerchantsAvailable).toHaveBeenCalled());
    expect(getMerchantsAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ lat: POSITION.coords.latitude, lng: POSITION.coords.longitude }),
    );
    await waitFor(() => expect(result.current.state.status).toBe('success'));
  });

  it('no exige el alias `location`, que incluye un permiso no declarado', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);
    render();

    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
    // Con la aproximada ya concedida no hay nada que pedir: si se pidiera el
    // alias `location`, Android lo negaría en seco y la pantalla moriría.
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('si hay que pedirlo, pide solo el alias aproximado', async () => {
    checkPermissions.mockResolvedValue({ location: 'prompt', coarseLocation: 'prompt' });
    requestPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'granted' });

    render();

    await waitFor(() => expect(requestPermissions).toHaveBeenCalled());
    expect(requestPermissions).toHaveBeenCalledWith({ permissions: ['coarseLocation'] });
    // Y con eso basta para continuar.
    await waitFor(() => expect(getMerchantsAvailable).toHaveBeenCalled());
  });

  /**
   * En el Redmi el síntoma no fue "falta el permiso" sino "revisa tu conexión":
   * pedir un permiso que no está declarado en el manifiesto revienta la llamada
   * nativa, la excepción cae en el catch genérico de geolocalización y la
   * pantalla acaba culpando a la red. Con el alias correcto ya concedido no hay
   * nada que pedir, así que ese camino ni se pisa.
   */
  it('no toca el camino que reventaba en el dispositivo', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);
    requestPermissions.mockRejectedValue(
      new Error('Permission ACCESS_FINE_LOCATION not declared in AndroidManifest.xml'),
    );

    const { result } = render();

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  /**
   * Segundo fallo de la misma sesión: con la verja ya abierta, la pantalla se
   * quedaba en "Buscando ofertas" hasta expirar. `maximumAge` vale 0 por
   * defecto, así que el plugin descarta la posición que el sistema ya tiene y
   * espera un fix nuevo — que bajo techo y con ubicación aproximada puede no
   * llegar. Para un radio de kilómetros esa distinción no significa nada.
   */
  it('acepta una posición reciente en vez de exigir un fix nuevo', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);
    render();

    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
    const opts = getCurrentPosition.mock.calls[0][0] as { maximumAge?: number };
    expect(opts.maximumAge).toBeGreaterThan(0);
  });

  /**
   * Tercer intento sobre lo mismo, y esta vez con el teléfono delante: una
   * ventana de 5 minutos NO bastó. El aparato llevaba 22 sin moverse, su última
   * posición quedaba fuera de la ventana, y la pantalla murió con
   * "Could not obtain location in time".
   */
  it('si no llega un fix nuevo, usa el último conocido en vez de rendirse', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);
    getCurrentPosition.mockRejectedValueOnce(new Error('Could not obtain location in time'));
    getCurrentPosition.mockResolvedValueOnce(POSITION);

    const { result } = render();

    await waitFor(() => expect(getMerchantsAvailable).toHaveBeenCalled());
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);

    // La segunda pasada acepta una posición mucho más vieja: para un radio de
    // kilómetros da igual, y enseñar agentes desactualizados es mejor que
    // no enseñar ninguno.
    const first = getCurrentPosition.mock.calls[0][0] as { maximumAge: number };
    const second = getCurrentPosition.mock.calls[1][0] as { maximumAge: number };
    expect(second.maximumAge).toBeGreaterThan(first.maximumAge);
    await waitFor(() => expect(result.current.state.status).toBe('success'));
  });

  it('no enseña el mensaje crudo del plugin, que viene en inglés', async () => {
    checkPermissions.mockResolvedValue(DEVICE_AFTER_T19);
    getCurrentPosition.mockRejectedValue(new Error('Could not obtain location in time.'));

    const { result } = render();

    await waitFor(() => expect(result.current.state.status).toBe('error'));
    const msg = (result.current.state as { error: string }).error;
    // "Try with a higher timeout" no le dice nada a quien solo quiere ver agentes.
    expect(msg).not.toMatch(/timeout|Could not obtain/i);
    expect(msg).toMatch(/ubicar|ubicación/i);
  });

  it('una negativa real sí se distingue de un fallo de red', async () => {
    checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });
    requestPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });

    const { result } = render();

    await waitFor(() => expect(result.current.state.status).toBe('location_denied'));
    expect(getMerchantsAvailable).not.toHaveBeenCalled();
  });
});
