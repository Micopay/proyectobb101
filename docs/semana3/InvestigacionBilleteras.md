# Investigación: billetera del usuario

**Autor:** José Alfredo Román Cruz ([@josealfredo79](https://github.com/josealfredo79))

**Fecha:** 15 de octubre de 2026

**Contexto:** la sección 2 de la [documentación de la semana 3](Documentacion.md) deja abierta la decisión de la billetera. El respaldo de la llave secreta es la barrera más fuerte que marcó nuestra investigación (V-4, V-22), y hay dos opciones en evaluación: smart wallets con passkeys (passkey-kit) y Pollar. Este documento responde las preguntas que quedaron abiertas en esa tabla y propone un camino.

---

## 1. Cómo funciona hoy la billetera en la app

Esto se revisó en el código del front (`frontend/src/lib/keystore.ts`), sin cambiarlo.

- Al registrarse, la app genera una llave Stellar clásica (cuenta `G...`) y la guarda en el almacenamiento seguro del teléfono.
- Para bloquear o liberar el escrow, el backend arma la transacción, el teléfono la firma completa con esa llave y el backend la envía. El contrato verifica la firma con `require_auth()` sobre la cuenta del usuario o del comercio.
- Antes de firmar, la app pide confirmar presencia (biometría o PIN del teléfono). Pero si la persona pierde el teléfono, la única forma de recuperar su cuenta es la llave secreta que respaldó. Esa es la barrera.

Cualquier opción nueva tiene que mantener dos cosas: que el escrow pueda pedir la autorización del usuario y que ni MicoPay ni un tercero puedan mover sus fondos por su cuenta.

---

## 2. Smart wallets con passkeys (passkey-kit)

[passkey-kit](https://github.com/kalepail/passkey-kit) es un kit de TypeScript para crear billeteras que son contratos en Soroban (cuentas `C...`). En vez de una llave secreta, la billetera reconoce como firmante una passkey: una credencial que vive en el teléfono y se desbloquea con huella o rostro.

### Respuestas a las dudas abiertas

| Duda | Respuesta |
| --- | --- |
| **Compatibilidad con el escrow** | Compatible en principio. En Soroban, `require_auth()` acepta tanto cuentas `G...` como contratos `C...`, y la billetera valida la firma de la passkey en su propia función `__check_auth`. Las cuentas de contrato también pueden tener saldo de USDC a través del contrato del activo, sin trustline. **Cambia el backend:** hoy el teléfono firma la transacción completa. Con passkey firma solo la autorización de la llamada al escrow, y otra cuenta (un *relayer*) paga la comisión y envía la transacción. |
| **Costo de despliegue por cuenta** | Cada usuario necesita desplegar su propio contrato de billetera. El kit hace que la comisión la pague el relayer (OpenZeppelin Relayer Channels), así que el usuario no necesita XLM, pero el costo lo absorbe MicoPay. La documentación no da una cifra: **hay que medirlo en testnet.** |
| **Soporte en Android con Capacitor** | Es el punto más delicado. Las passkeys usan WebAuthn, y el WebView de Android que usa Capacitor no lo expone por defecto. Hay plugins que lo resuelven ([Capawesome Passkeys](https://capawesome.io/docs/sdks/capacitor/passkeys/), [Capgo capacitor-passkey](https://capgo.app/plugins/capacitor-passkey/)) llevando la petición al Credential Manager de Android. Además, hace falta un dominio propio que publique `/.well-known/assetlinks.json` para vincular la app con la passkey. |
| **Custodia** | Propia: la passkey nunca sale del teléfono ni de la cuenta de Google del usuario, que la sincroniza. MicoPay no puede firmar por la persona. Se mantiene la promesa del producto. |
| **Recuperación** | Las passkeys de Android se sincronizan con el gestor de contraseñas de Google, así que si cambia de teléfono la recupera iniciando sesión en su cuenta de Google. Se puede agregar un segundo firmante como respaldo. |

### Riesgos

- El kit avisa que hay que revisar el contrato y el SDK antes de manejar montos reales. No encontramos una auditoría del contrato de passkey-kit. El kit hermano, [smart-account-kit](https://github.com/stellar/smart-account-kit), se basa en la cuenta auditada de OpenZeppelin, pero no es intercambiable con passkey-kit.
- Tiene casos conocidos que hay que cuidar: dejar siempre un firmante administrador y verificar los firmantes de la billetera, no solo su dirección derivada (riesgo de que alguien se adelante al despliegue).
- Requiere nuevas piezas: un relayer para pagar comisiones y, opcionalmente, un indexador para buscar billeteras por firmante.

---

## 3. Pollar

[Pollar](https://docs.pollar.xyz/docs) es un SDK de onboarding y activación de billeteras para Stellar (y ahora también Solana). Resuelve el registro con correo, Google o GitHub, crea y activa la cuenta y patrocina las comisiones y las trustlines.

### Respuestas a las dudas abiertas

| Duda | Respuesta |
| --- | --- |
| **Modelo de custodia** | Ofrece varios. En las billeteras administradas por Pollar, la documentación no deja claro quién guarda la llave. La opción co-firmada usa Turnkey con un esquema 2 de 2: el teléfono del usuario y Pollar firman juntos. También permite conectar billeteras externas (Freighter, Albedo, Stellar Wallets Kit) o embebidas (Privy). **En las dos opciones administradas, Pollar participa en cada firma**, que es justo lo que el Blueprint quiere evitar: que el usuario tenga que confiar en un tercero. |
| **Soporte para React con Capacitor** | Hay paquetes para React (`@pollar/react`, React 18 o superior) y React Native. Capacitor no se menciona. Al ser React web, debería funcionar dentro del WebView, pero el login con passkeys tendría el mismo problema de WebAuthn que la opción anterior. **Hay que probarlo.** |
| **Autorización para llamar al escrow** | No está documentado. Pollar menciona una lista de contratos de Soroban permitidos y políticas que restringen operaciones, pero no explica cómo firmar una llamada arbitraria a un contrato propio como nuestro escrow. **Hay que preguntarle al equipo de Pollar.** |
| **Costo** | Requiere una llave de API (`pk_...`). La documentación no publica precios. **Hay que preguntarlo.** |
| **Testnet** | Las llaves de API distinguen testnet y mainnet, pero los detalles de testnet en Stellar no están documentados. |

### Riesgos

- Depender de un proveedor externo para crear cuentas y firmar. Si Pollar cambia su precio o deja de operar, la billetera de los usuarios depende de él.
- El SDK cambia rápido: tuvo cambios incompatibles en las versiones 0.10.0 y 0.11.0, y la versión actual es la 0.11.5. Su licencia es Apache-2.0.

---

## 4. Comparación

| Criterio | Passkeys (passkey-kit) | Pollar |
| --- | --- | --- |
| Elimina la llave secreta para el usuario | Sí, entra con huella o rostro | Sí, entra con correo o redes sociales |
| Custodia | Propia | Administrada o co-firmada (depende de la opción) |
| Funciona con nuestro escrow | Sí, con cambios en el backend | Sin confirmar |
| Soporte en Android con Capacitor | Con un plugin y un dominio con `assetlinks.json` | Sin confirmar |
| Costo para MicoPay | Despliegue de cada billetera y comisiones del relayer | Precio del servicio (no publicado) |
| Madurez | Sin auditoría publicada del contrato | SDK joven, con cambios frecuentes |
| Dependencia de terceros | Baja (relayer reemplazable) | Alta |

---

## 5. Recomendación

**Para el MVP, recomiendo las smart wallets con passkeys.** Es la única opción que elimina la llave secreta sin que un tercero participe en cada firma, y eso es lo que promete MicoPay: que nadie tenga que confiar primero en nadie, tampoco en nosotros. Además, ya sabemos que el escrow puede pedir la autorización de una cuenta de contrato. Pollar resuelve muy bien el registro, pero sus opciones administradas meten a Pollar en la firma, y no está documentado si puede llamar a nuestro contrato.

Pollar puede servir más adelante para otras partes que deja fuera el MVP, como las rampas de entrada y salida o el cumplimiento KYC por país.

Mientras se integran las passkeys, la billetera actual puede quedarse como respaldo para quien ya tiene cuenta.

---

## 6. Siguientes pasos para confirmar la decisión

1. **Probar WebAuthn en la app Android:** instalar un plugin de passkeys de Capacitor en una rama de prueba y confirmar que se puede crear y usar una passkey en el teléfono. Es el riesgo más grande.
2. **Medir el costo en testnet:** desplegar algunas billeteras con passkey-kit y anotar cuánto cuesta el despliegue y cada llamada al escrow pagada por el relayer.
3. **Hacer un bloqueo y una liberación del escrow con una cuenta `C...`:** confirmar que el contrato actual funciona sin cambios y medir qué hay que cambiar en el backend para firmar solo la autorización.
4. **Revisar el contrato de la billetera:** decidir entre passkey-kit y smart-account-kit (basado en OpenZeppelin, auditado) antes de usar dinero real.
5. **Escribir a Pollar** para cerrar las dudas pendientes: custodia exacta en Stellar, llamadas a contratos propios, soporte en testnet y precio.

---

## Fuentes

- [passkey-kit (GitHub)](https://github.com/kalepail/passkey-kit) y su [README v0.14.0](https://cdn.jsdelivr.net/npm/passkey-kit@0.14.0/README.md)
- [Pollar (GitHub)](https://github.com/pollar-xyz/pollar) y la [documentación de Pollar](https://docs.pollar.xyz/docs)
- [smart-account-kit (GitHub)](https://github.com/stellar/smart-account-kit)
- [Capawesome: plugin de passkeys para Capacitor](https://capawesome.io/docs/sdks/capacitor/passkeys/)
- [Capgo: capacitor-passkey](https://capgo.app/plugins/capacitor-passkey/)
- [passkeys.dev: referencia de Android](https://passkeys.dev/docs/reference/android/)
- [Corbado: los WebViews y las passkeys en apps móviles](https://www.corbado.com/faq/webviews-challenge-passkeys-mobile-apps)
