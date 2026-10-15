import { registerPlugin } from '@capacitor/core';

/**
 * Puente al plugin nativo que aplica FLAG_SECURE a la ventana de Android.
 *
 * Se usa mientras la llave secreta Stellar está visible en pantalla: bloquea
 * capturas, grabación de pantalla y la miniatura del conmutador de apps.
 *
 * En web no hay equivalente — el navegador no puede impedir una captura — así
 * que el fallback no hace nada. Se declara explícitamente para que llamar a
 * estos métodos desde la PWA no lance "plugin not implemented".
 *
 * Auditoría 2026-08, ISSUE-03 / SEC-33.
 */
export interface SecureScreenPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

export const SecureScreen = registerPlugin<SecureScreenPlugin>('SecureScreen', {
  web: {
    async enable() {},
    async disable() {},
  },
});

/**
 * Envuelve un bloque de código con la pantalla protegida.
 *
 * Garantiza que FLAG_SECURE se retira aunque el bloque lance, que es el caso
 * que importa: si el usuario cancela o navega atrás con una excepción de por
 * medio, la app no puede quedarse con las capturas bloqueadas para siempre.
 */
export async function withSecureScreen<T>(fn: () => Promise<T>): Promise<T> {
  await SecureScreen.enable().catch(() => {});
  try {
    return await fn();
  } finally {
    await SecureScreen.disable().catch(() => {});
  }
}
