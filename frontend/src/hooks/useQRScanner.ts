import { useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { useCameraPermission, type PermState } from './usePermission';

export interface ScanResult {
  value: string | null;
  error?: string;
  permState?: PermState;
}

export function useQRScanner() {
  const { state: permState, request: requestPerm, openSettings } = useCameraPermission();

  const scan = useCallback(async (): Promise<ScanResult> => {
    if (!Capacitor.isNativePlatform()) {
      // Web: caller should render a manual paste UI instead of calling scan()
      return { value: null, error: 'scanner_unavailable' };
    }

    const mod = await import('@capacitor-mlkit/barcode-scanning');
    const { BarcodeScanner, BarcodeFormat } = mod;

    // check-before-request: detects permanently_denied without showing dialog
    const perm = await requestPerm();
    if (perm !== 'granted') {
      return { value: null, permState: perm };
    }

    const supported = await BarcodeScanner.isSupported();
    if (!supported.supported) {
      return { value: null, error: 'Scanner no disponible en este device' };
    }

    try {
      const { barcodes } = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
      });
      return { value: barcodes[0]?.rawValue ?? null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : 'Scan cancelado' };
    }
  }, [requestPerm]);

  return { scan, permState, requestPermission: requestPerm, openSettings };
}
