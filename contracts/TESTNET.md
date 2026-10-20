# MicoPay — Stellar Testnet Reference

Canonical IDs for the **mobile stack** (micopay-backend + micopay/frontend).
The `micopay-api` x402 service uses a separate escrow contract; do not mix them.

## Escrow multiactivo (desde 2026-10-08)

Instancias con el fix de `lock` (#420), una por activo. Las despliega
`deploy-mainnet.sh` con las variables de testnet (ver MAINNET.md).

| Activo | Escrow | Token (SAC) |
|---|---|---|
| USDC (emisor propio de pruebas `GADK7SUS7NHIGERQBKF7R67A5DNIEFWG4YKNHLTQM5JN4KP2QISMJSHG`) | `CDUI253FSVVVXUBI4SU3PEQIDNCYWGABGUOCRBIINRCJ4SJ5XVKWYGAX` | `CCVAWF4XCJ5DLXHOFGO4TDEQBR6VJTIE5JYCZTXHCDULZ4XYH4GCVD23` |
| XLM | `CBFDXYUPL4Q37JP3JD6JHFG6BQGNG6VOTTGMBTTPE5TYDHOVRY5UNQWE` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

- Admin y wallet de plataforma de ambas: `GBD4V322KREETWAVJXMYUJP6CIWFKBEYT6L4NAXTXLQ7XNY535QQEGMQ`
  (alias `ensayo-mainnet-script` del CLI `stellar`, solo testnet).
- El USDC de testnet es un activo propio, no el de Circle: asi se puede emitir
  a las billeteras de demo sin depender del faucet. La llave del emisor esta en
  `~/.micopay/ensayo-usdc.json` (PC de Eric).
- Backend: `ESCROW_CONTRACTS=USDC=CDUI…,XLM=CBFD…` y
  `ESCROW_LEGACY_CONTRACT_ID=CB4M…` para las operaciones anteriores.

## Contract IDs (instancia original, solo XLM, sin el fix de #420)

| Contract | ID |
|----------|----|
| MicopayEscrow (HTLC) | `CB4M5777YFQWKGDUULCX5W6PXEDJSJARDTMH4VV6FXC4W4UPANALO3HZ` |
| **XLM (native) SAC** — token del escrow | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| MXNe issuer address (sin SAC desplegado) | `GBZXN7PIRZGNMHGA7MUUUF4GWMTISGNQ5E72TFL6GDWPE6K4RCAVOALV` |

> ⚠️ **Corregido el 2026-09-05.** Esta tabla etiquetaba `CDLZFC3S…` como "MXNe
> token contract". **Es el Stellar Asset Contract del XLM nativo**, verificado
> de dos formas independientes: su `symbol()` devuelve `native`, y
> `Asset.native().contractId(Networks.TESTNET)` da exactamente ese ID.
>
> El error costo caro. El diagnostico WP0 del plan multiactivo (2026-07-02) leyo
> correctamente el `TokenId` del escrow en cadena, lo comparo contra esta tabla,
> concluyo "la instancia es MXNe" y de ahi dedujo que la conversion 1:1 del
> backend era correcta. No lo era: el escrow bloquea XLM, y `amount_stroops =
> amount_mxn * 10^7` hacia que una operacion de 500 pesos bloqueara 500 XLM
> (~1 563 pesos). La verificacion fue real; la referencia contra la que se
> comparo estaba mal.
>
> No hay ningun SAC de MXNe desplegado en testnet a dia de hoy. El issuer de
> arriba existe, pero su contrato de activo no.

Both contracts verified live on testnet (`stellar contract fetch --network testnet --id <ID>`
returns valid WASM with `initialize`, `lock`, `refund`, `release`, `get_trade` exports).

## Platform account

| Key | Value |
|-----|-------|
| Public key | `GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK` |
| Secret key  | Set as `PLATFORM_SECRET_KEY` in Render dashboard (never commit) |
| Funded      | 2026-06-27 via friendbot |
| Role        | Signs all on-chain HTLC lock/release/refund txs as escrow operator |

To re-fund (testnet XLM expires):
```
stellar keys fund GDKKW2WSMQWZ63PIZBKDDBAAOBG5FP3TUHRYQ4U5RBKTFNESL5K5BJJK \
  --network testnet \
  --network-passphrase "Test SDF Network ; September 2015"
```

## Env vars

Backend (`render.yaml` / `.env`):
```
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=TESTNET
ESCROW_CONTRACT_ID=CB4M5777YFQWKGDUULCX5W6PXEDJSJARDTMH4VV6FXC4W4UPANALO3HZ
MXNE_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
MXNE_ISSUER_ADDRESS=GBZXN7PIRZGNMHGA7MUUUF4GWMTISGNQ5E72TFL6GDWPE6K4RCAVOALV
```

Frontend (`.env.testnet`):
```
VITE_ESCROW_CONTRACT_ID=CB4M5777YFQWKGDUULCX5W6PXEDJSJARDTMH4VV6FXC4W4UPANALO3HZ
VITE_MXNE_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
VITE_MXNE_ISSUER_ADDRESS=GBZXN7PIRZGNMHGA7MUUUF4GWMTISGNQ5E72TFL6GDWPE6K4RCAVOALV
VITE_API_URL=https://micopay-backend.onrender.com  # confirm after first Render deploy
```

## Re-deploying the escrow contract

Source: `micopay/contracts/escrow/` (Rust/Soroban).

```bash
cd micopay/contracts/escrow
stellar contract build
stellar contract deploy \
  --wasm target/wasm32v1-none/release/micopay_escrow.wasm \
  --source <platform_secret> \
  --network testnet \
  --network-passphrase "Test SDF Network ; September 2015"
# → prints new contract ID; update ESCROW_CONTRACT_ID everywhere
```

After redeploying, call `initialize` with the platform address before first use.
