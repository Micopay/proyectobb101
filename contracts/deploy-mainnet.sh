#!/usr/bin/env bash
# Despliega una instancia del escrow en MAINNET. Cada instancia bloquea un solo
# token (se fija en initialize), asi que hay una por activo:
#
#   TOKEN=USDC bash deploy-mainnet.sh   # USDC de Circle (default)
#   TOKEN=XLM  bash deploy-mainnet.sh   # XLM nativo
#
# Requisitos:
#   - Llave de plataforma en el CLI de stellar con el alias de abajo, fondeada
#     con XLM real (~10 XLM: despliegues, reserva de la trustline y comisiones).
#   - Ejecutar desde micopay/contracts.
#
# Pasos (cada uno se puede repetir sin romper nada, salvo initialize, que el
# contrato rechaza una segunda vez):
#   1. USDC: trustline en la cuenta de plataforma (recibe la comision en release)
#   2. build + deploy del WASM
#   3. initialize(admin, token, wallet de plataforma)
set -euo pipefail

TOKEN="${TOKEN:-USDC}"
SOURCE="${SOURCE:-micopay-platform-mainnet}"
RPC_URL="${RPC_URL:-https://mainnet.sorobanrpc.com}"
PASSPHRASE="${PASSPHRASE:-Public Global Stellar Network ; September 2015}"
HORIZON="${HORIZON:-https://horizon.stellar.org}"
USDC_ASSET="${USDC_ASSET:-USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN}"
# SACs en mainnet, derivados con Asset(...).contractId(Networks.PUBLIC). El de
# USDC se verifico en cadena el 2026-10-07 (ejecutable = Stellar Asset).
USDC_SAC="${USDC_SAC:-CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75}"
XLM_SAC="${XLM_SAC:-CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA}"
# Las variables de arriba se pueden sobrescribir para ensayar en testnet.

case "$TOKEN" in
  USDC) TOKEN_SAC="$USDC_SAC" ;;
  XLM)  TOKEN_SAC="$XLM_SAC" ;;
  *) echo "TOKEN debe ser USDC o XLM" >&2; exit 1 ;;
esac

NET=(--rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE")
PLATFORM="$(stellar keys address "$SOURCE")"
echo "Plataforma: $PLATFORM · token: $TOKEN ($TOKEN_SAC)"

if [ "$TOKEN" = "USDC" ]; then
  echo "1/3 Trustline de USDC en la cuenta de plataforma…"
  # Se busca el EMISOR, no solo el codigo: cualquiera puede emitir un "USDC".
  if curl -s "$HORIZON/accounts/$PLATFORM" | grep -q "\"asset_issuer\": \"${USDC_ASSET#*:}\""; then
    echo "    ya existe"
  else
    stellar tx new change-trust --source "$SOURCE" --line "$USDC_ASSET" "${NET[@]}"
  fi
else
  echo "1/3 XLM nativo: no necesita trustline"
fi

echo "2/3 Build y deploy…"
(cd escrow && stellar contract build)
CONTRACT_ID="$(stellar contract deploy \
  --wasm escrow/target/wasm32v1-none/release/micopay_escrow.wasm \
  --source "$SOURCE" "${NET[@]}")"
echo "    contrato: $CONTRACT_ID"

echo "3/3 initialize…"
stellar contract invoke --id "$CONTRACT_ID" --source "$SOURCE" "${NET[@]}" -- \
  initialize --admin "$PLATFORM" --token_id "$TOKEN_SAC" --platform_wallet "$PLATFORM"

cat <<EOF

Listo. Agrega la instancia a MAINNET.md y a ESCROW_CONTRACTS en la task definition:
  ESCROW_CONTRACTS=...,$TOKEN=$CONTRACT_ID
EOF
