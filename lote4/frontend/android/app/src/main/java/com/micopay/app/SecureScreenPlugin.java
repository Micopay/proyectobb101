package com.micopay.app;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Marca la ventana como segura mientras se muestra la llave secreta Stellar.
 *
 * Con FLAG_SECURE activo, Android bloquea las capturas de pantalla, la
 * grabación de pantalla y la miniatura que aparece en el conmutador de apps.
 *
 * Se activa y desactiva bajo demanda en vez de dejarlo puesto para toda la
 * app a propósito: si estuviera siempre activo, la gente del piloto no podría
 * mandar capturas a soporte, que es como se reporta la mayoría de los fallos.
 *
 * Auditoría 2026-08, ISSUE-03 / SEC-33.
 */
@CapacitorPlugin(name = "SecureScreen")
public class SecureScreenPlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        // Los flags de ventana solo se pueden tocar desde el hilo de UI.
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }
}
