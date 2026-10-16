# Investigación: billetera del usuario

**Autor:** José Alfredo Román Cruz ([@josealfredo79](https://github.com/josealfredo79))

**Fecha:** 15 de octubre de 2026

**Contexto:** la sección 2 de la [documentación de la semana 3](Documentacion.md) deja abierta la decisión de la billetera. El respaldo de la llave secreta es la barrera más fuerte que marcó nuestra investigación (V-4, V-22), y hay dos opciones en evaluación: smart wallets con passkeys (passkey-kit) y Pollar. Este documento responde las preguntas que quedaron abiertas en esa tabla y propone un camino.

> **⚠️ CUIDADO: una passkey no firma transacciones de Stellar por sí sola.** Las cuentas clásicas de Stellar (`G...`) solo aceptan firmas Ed25519, y una passkey firma con otra curva (secp256r1). La passkey solo sirve dentro de una billetera que es un contrato en Soroban (`C...`), y ahí solo autoriza llamadas a contratos. No puede pagar comisiones, no puede ser la cuenta que envía la transacción y no sirve para el inicio de sesión que usa hoy la app. Los detalles están en la sección 2.1. Tampoco encontramos que Trustless Work, el servicio de escrow del ecosistema, haya implementado firmas con passkey (sección 3).

---

## 1. Cómo funciona hoy la billetera en la app

Esto se revisó en el código del front (`frontend/src/lib/keystore.ts`), sin cambiarlo.

- Al registrarse, la app genera una llave Stellar clásica (cuenta `G...`) y la guarda en el almacenamiento seguro del teléfono.
- Para bloquear o liberar el escrow, el backend arma la transacción, el teléfono la firma completa con esa llave y el backend la envía. El contrato verifica la firma con `require_auth()` sobre la cuenta del usuario o del comercio.
- Antes de firmar, la app pide confirmar presencia (biometría o PIN del teléfono). Pero si la persona pierde el teléfono, la única forma de recuperar su cuenta es la llave secreta que respaldó. Esa es la barrera.

Cualquier opción nueva tiene que mantener dos cosas: que el escrow pueda pedir la autorización del usuario y que ni MicoPay ni un tercero puedan mover sus fondos por su cuenta.

---

## 2. Smart wallets con passkeys (passkey-kit)

[passkey-kit](https://github.com/stellar/passkey-kit) (antes en `kalepail/passkey-kit`, ahora mantenido en la organización de Stellar) es un kit de TypeScript para crear billeteras que son contratos en Soroban (cuentas `C...`). En vez de una llave secreta, la billetera reconoce como firmante una passkey: una credencial que vive en el teléfono y se desbloquea con huella o rostro.

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

### 2.1 ⚠️ CUIDADO: lo que una passkey NO puede firmar

La billetera con passkey no reemplaza a la llave actual uno a uno. Estas son las cosas que hoy hace la llave `G...` de la app y que una passkey no puede hacer igual:

| Lo que hace hoy la app | ¿Lo puede firmar una passkey? | Qué habría que cambiar |
| --- | --- | --- |
| **Firmar la transacción completa** del escrow (`signTransactionXdr` en `keystore.ts`) | ❌ No. Una passkey no es un firmante válido de una transacción de Stellar. | La passkey firma solo la *autorización* de la llamada al escrow (auth entry), y otra cuenta `G...` (el relayer de MicoPay o de un tercero) envía la transacción y paga la comisión. El backend tiene que armar las transacciones de otra forma. |
| **Iniciar sesión** firmando un reto con la llave (`signChallenge`) | ❌ No. El reto se firma con Ed25519 y se verifica contra la cuenta `G...`. | Un inicio de sesión nuevo para cuentas de contrato. El estándar para eso, [SEP-45](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md), sigue en **borrador** (versión 0.1.1). |
| **Pagar comisiones de red** con XLM propio | ❌ No. Una cuenta de contrato no puede ser la cuenta que paga. | Depender siempre de un relayer. Si el relayer se cae, el usuario no puede mover su dinero. |
| **Recibir USDC** de cualquier billetera o casa de cambio | ⚠️ No siempre. Muchas billeteras y casas de cambio todavía no envían a direcciones `C...`, y las transacciones de Soroban no llevan *memo*. | Confirmar que quien manda la remesa al usuario puede enviar a una dirección `C...`. Si no, el flujo 1 del Blueprint (recibir USDC) se rompe. |
| **Llamar al escrow** (`require_auth()` del usuario o comercio) | ✅ Sí, si el contrato recibe la cuenta como `Address`. | Probarlo en testnet con el contrato actual. |

**Conclusión de esta sección:** con passkeys sí se puede usar el escrow, pero no "firmar como hoy". Cambia la forma de iniciar sesión, de enviar transacciones y de pagar comisiones, y aparece una dependencia nueva: el relayer.

---

## 3. ⚠️ CUIDADO: Trustless Work no tiene firma con passkeys

[Trustless Work](https://www.trustlesswork.com/) es la infraestructura de escrow en USDC más conocida del ecosistema Stellar y era la alternativa natural a nuestro contrato propio (opción B). Revisamos si ya resolvió las firmas con passkey, porque sería la prueba de que se puede hacer:

- Su API devuelve transacciones sin firmar (XDR) y pide **firmarlas en el cliente con la billetera del rol** ([documentación](https://docs.trustlesswork.com/trustless-work/api-rest/introduction)). Es firma de transacción completa, la que una passkey no puede hacer.
- Su app de ejemplo y su backoffice se conectan con billeteras a través de [Stellar Wallets Kit](https://docs.trustlesswork.com/trustless-work/developer-resources/stellar-wallet-kit-quick-integration) (Freighter y similares, cuentas `G...`). En el `package.json` de sus repositorios no aparece passkey-kit ni smart-account-kit.
- La única mención a passkeys es un texto de la página principal de su backoffice ("Sign the transaction using wallet or passkey"). No encontramos código que lo implemente.

**Hasta donde pudimos revisar, Trustless Work no implementó firmas con passkey.** No es una confirmación oficial, así que conviene preguntarles directamente. Pero es una señal clara: si el principal servicio de escrow de Stellar no lo ha resuelto, integrarlo nosotros no es trivial.

---

## 4. Pollar

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

## 5. Comparación

| Criterio | Passkeys (passkey-kit) | Pollar |
| --- | --- | --- |
| Elimina la llave secreta para el usuario | Sí, entra con huella o rostro | Sí, entra con correo o redes sociales |
| Custodia | Propia | Administrada o co-firmada (depende de la opción) |
| Firma transacciones completas de Stellar | ⚠️ No: solo autoriza llamadas a contratos y necesita un relayer | Sí, con su cuenta `G...` |
| Inicio de sesión de la app | ⚠️ Hay que rehacerlo (SEP-45, en borrador) | Lo resuelve Pollar |
| Funciona con nuestro escrow | Sí, con cambios en el backend | Sin confirmar |
| Soporte en Android con Capacitor | Con un plugin y un dominio con `assetlinks.json` | Sin confirmar |
| Costo para MicoPay | Despliegue de cada billetera y comisiones del relayer | Precio del servicio (no publicado) |
| Madurez | Sin auditoría publicada del contrato | SDK joven, con cambios frecuentes |
| Dependencia de terceros | Baja (relayer reemplazable) | Alta |

---

## 6. Recomendación

> **⚠️ No recomendamos passkeys por ahora.** Ni Alberto Chávez (experto en Stellar) ni José Alfredo Román Cruz recomiendan usar passkeys en MicoPay en este momento, por los límites de la sección 2.1 y porque Trustless Work tampoco las ha implementado (sección 3). Solo se volverían a considerar si pasan las pruebas de la sección 7.

**Para el MVP, no cambiaría todavía la billetera actual.** La llave `G...` en el teléfono funciona hoy con el escrow, firma transacciones completas y no depende de nadie. Lo que conviene mejorar en el MVP es el *respaldo* de esa llave (la barrera de V-4 y V-22), no reemplazarla.

**Las passkeys quedan como posibilidad para después del MVP, no como recomendación.** En teoría es la única opción que elimina la llave secreta sin que un tercero participe en cada firma, y eso es lo que promete MicoPay: que nadie tenga que confiar primero en nadie, tampoco en nosotros. Pero tienen límites reales (sección 2.1): necesitan un relayer, un inicio de sesión nuevo cuyo estándar sigue en borrador y una cuenta `C...` que no todas las billeteras pueden recibir. Y ni siquiera Trustless Work las ha integrado (sección 3).

**Pollar** resuelve muy bien el registro, pero sus opciones administradas meten a Pollar en la firma, y no está documentado si puede llamar a nuestro contrato. Puede servir más adelante para partes que el MVP deja fuera, como las rampas de entrada y salida o el KYC por país.

---

## 7. Siguientes pasos para confirmar la decisión

1. **Probar WebAuthn en la app Android:** instalar un plugin de passkeys de Capacitor en una rama de prueba y confirmar que se puede crear y usar una passkey en el teléfono.
2. **Hacer un bloqueo y una liberación del escrow con una cuenta `C...`:** confirmar que el contrato actual funciona sin cambios, con la passkey firmando solo la autorización y un relayer enviando la transacción.
3. **Probar el inicio de sesión con una cuenta `C...`:** ver qué tanto cambia el backend para seguir SEP-45 o un mecanismo propio.
4. **Probar la recepción de USDC en una dirección `C...`:** desde las billeteras y casas de cambio que usarían quienes mandan remesas.
5. **Medir el costo en testnet:** el despliegue de cada billetera y cada llamada al escrow pagada por el relayer.
6. **Revisar el contrato de la billetera:** decidir entre passkey-kit y smart-account-kit (basado en OpenZeppelin, auditado) antes de usar dinero real.
7. **Preguntar a Trustless Work** si tienen firmas con passkey en desarrollo y cómo lo resolverían.
8. **Escribir a Pollar** para cerrar las dudas pendientes: custodia exacta en Stellar, llamadas a contratos propios, soporte en testnet y precio.

---

## Fuentes

- [passkey-kit (GitHub)](https://github.com/stellar/passkey-kit) y su [README v0.14.0](https://cdn.jsdelivr.net/npm/passkey-kit@0.14.0/README.md)
- [Stellar Docs: smart wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)
- [SEP-45: autenticación web para cuentas de contrato (borrador)](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md)
- [Stellagate: compatibilidad de direcciones `C...` y memos](https://github.com/StellaGate/stellagate)
- [Trustless Work: introducción a la API](https://docs.trustlesswork.com/trustless-work/api-rest/introduction), [integración con Stellar Wallets Kit](https://docs.trustlesswork.com/trustless-work/developer-resources/stellar-wallet-kit-quick-integration) y [repositorios en GitHub](https://github.com/Trustless-Work)
- [Pollar (GitHub)](https://github.com/pollar-xyz/pollar) y la [documentación de Pollar](https://docs.pollar.xyz/docs)
- [smart-account-kit (GitHub)](https://github.com/stellar/smart-account-kit)
- [Capawesome: plugin de passkeys para Capacitor](https://capawesome.io/docs/sdks/capacitor/passkeys/)
- [Capgo: capacitor-passkey](https://capgo.app/plugins/capacitor-passkey/)
- [passkeys.dev: referencia de Android](https://passkeys.dev/docs/reference/android/)
- [Corbado: los WebViews y las passkeys en apps móviles](https://www.corbado.com/faq/webviews-challenge-passkeys-mobile-apps)
