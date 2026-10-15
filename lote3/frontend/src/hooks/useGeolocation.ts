import { useEffect, useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { useLocationPermission, type PermState } from './usePermission';

export interface GeoState {
  lat: number | null;
  lng: number | null;
  loading: boolean;
  error: string | null;
  permState: PermState;
}

export function useGeolocation(enabled = true): GeoState & {
  requestPermission: () => Promise<PermState>;
  openSettings: () => void;
} {
  const { state: permState, check, request: requestPerm, openSettings } = useLocationPermission();
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null; loading: boolean; error: string | null }>({
    lat: null,
    lng: null,
    loading: false,
    error: null,
  });

  const fetchPosition = useCallback(async () => {
    setCoords(s => ({ ...s, loading: true, error: null }));
    try {
      if (!Capacitor.isNativePlatform()) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 })
        );
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, loading: false, error: null });
        return;
      }
      const { Geolocation } = await import('@capacitor/geolocation');
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 8000 });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, loading: false, error: null });
    } catch (e) {
      setCoords({
        lat: null,
        lng: null,
        loading: false,
        error: e instanceof Error ? e.message : 'No se pudo obtener ubicación',
      });
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<PermState> => {
    if (!Capacitor.isNativePlatform()) {
      // Web: browser handles its own permission dialog inside fetchPosition
      await fetchPosition();
      return 'granted';
    }
    const perm = await requestPerm();
    if (perm === 'granted') await fetchPosition();
    return perm;
  }, [requestPerm, fetchPosition]);

  useEffect(() => {
    if (!enabled) return;
    if (!Capacitor.isNativePlatform()) {
      // Web: browser handles permission internally; fetch directly
      fetchPosition();
      return;
    }
    // Native: only check current state — never fire OS dialog on mount.
    // ExploreMap renders PermissionGate rationale first; user triggers OS dialog via CTA.
    check().then(perm => {
      if (perm === 'granted') fetchPosition();
    });
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-check when app returns from background (e.g. user granted from system settings).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removed = false;
    let handle: { remove: () => Promise<void> } | null = null;
    import('@capacitor/app').then(({ App }) => {
      if (removed) return;
      App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) return;
        check().then(perm => { if (perm === 'granted') fetchPosition(); });
      }).then(h => { if (removed) h.remove(); else handle = h; });
    });
    return () => { removed = true; handle?.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ...coords,
    permState,
    requestPermission,
    openSettings,
  };
}
