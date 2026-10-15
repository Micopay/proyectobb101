export const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

/** Static QR shown when the backend is unreachable — demo builds only. */
export const DEMO_QR_PAYLOAD = 'MICOPAY:DEMO:mock_secret_for_ui_preview';

/** Returns the demo QR payload or throws if called outside demo mode. */
export function getDemoQrPayload(): string {
  if (!IS_DEMO_MODE) {
    throw new Error('Demo QR payload is only available when VITE_DEMO_MODE=true');
  }
  return DEMO_QR_PAYLOAD;
}
