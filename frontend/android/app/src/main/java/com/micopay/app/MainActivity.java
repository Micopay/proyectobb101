package com.micopay.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins locales de la app se registran antes de super.onCreate(),
        // porque es ahí donde el bridge construye la lista de plugins
        // disponibles. Los plugins que vienen de node_modules se cargan solos
        // desde capacitor.plugins.json; este vive en el propio proyecto y no
        // aparece en ese archivo.
        registerPlugin(SecureScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
