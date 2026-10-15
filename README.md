# MicoPay

## Requisitos

- Node.js 20 o superior (probado con Node 22)
- npm 10 o superior
- Para generar la app Android (opcional): Android Studio con el SDK de Android

## Instalación

```sh
git clone https://github.com/Micopay/proyectobb101.git
cd proyectobb101/frontend
npm install
```

## Cómo correrlo

Front conectado al backend de testnet de MicoPay:

```sh
npm run dev -- --mode testnet
```

Abre http://localhost:5181 en el navegador.

Si corres tu propio backend, copia `.env.example` a `.env`, ajusta `VITE_API_URL` y ejecuta `npm run dev`.

Versión de producción local:

```sh
npm run build:testnet
npm run preview
```
