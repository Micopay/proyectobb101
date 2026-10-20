/**
 * agent-wallet.mjs — "Juanita Tienda", the agent's own MicoPay account.
 *
 * Mirrors exactly what the mobile wallet does (Register.tsx + keystore.ts +
 * api.ts's lock/release flow), just driven from the CLI instead of a phone.
 * The secret key is generated and signs locally here — it is never sent to
 * the backend. State (keypair, user id, JWT) is kept in .agent-wallet/
 * (git-ignored), outside the repo's tracked files.
 *
 * Usage:
 *   node micopay/backend/scripts/agent-wallet.mjs register [username]
 *   node micopay/backend/scripts/agent-wallet.mjs login
 *   node micopay/backend/scripts/agent-wallet.mjs whoami
 *   node micopay/backend/scripts/agent-wallet.mjs trustline <ASSET_CODE> <ISSUER>
 *   node micopay/backend/scripts/agent-wallet.mjs release <tradeId>
 *
 * Env overrides:
 *   AGENT_API_URL    backend base URL (default http://localhost:3002)
 *   AGENT_NETWORK    'testnet' (default) or 'mainnet' — selects Horizon URL
 *                    and network passphrase together, so they can never
 *                    silently disagree. Override either individually with
 *                    AGENT_HORIZON_URL / AGENT_NETWORK_PASSPHRASE if needed.
 *
 * IMPORTANT: every command prints which network it's about to use before
 * doing anything — this script signs real transactions (ChangeTrust,
 * lock/release), so a mismatched network here means funds move on the
 * wrong chain silently. Always confirm the printed network before
 * proceeding when pointing AGENT_API_URL at a non-local backend.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// El script vive en micopay/backend/scripts/, pero su estado sigue en la raiz
// del repo (.agent-wallet/), donde ya existe la cuenta: subir tres niveles.
const ROOT = resolve(__dirname, '..', '..', '..');
const STATE_DIR = resolve(ROOT, '.agent-wallet');
const STATE_PATH = resolve(STATE_DIR, 'juanita.json');

const API_URL = process.env.AGENT_API_URL || 'http://localhost:3002';
const AGENT_NETWORK = process.env.AGENT_NETWORK || 'testnet';
const NETWORK_DEFAULTS = {
  testnet: { horizonUrl: 'https://horizon-testnet.stellar.org', passphrase: StellarSdk.Networks.TESTNET },
  mainnet: { horizonUrl: 'https://horizon.stellar.org', passphrase: StellarSdk.Networks.PUBLIC },
};
if (!NETWORK_DEFAULTS[AGENT_NETWORK]) {
  throw new Error(`AGENT_NETWORK must be 'testnet' or 'mainnet', got '${AGENT_NETWORK}'`);
}
const HORIZON_URL = process.env.AGENT_HORIZON_URL || NETWORK_DEFAULTS[AGENT_NETWORK].horizonUrl;
const NETWORK_PASSPHRASE = process.env.AGENT_NETWORK_PASSPHRASE || NETWORK_DEFAULTS[AGENT_NETWORK].passphrase;
const DEFAULT_USERNAME = 'juanita_tienda';

console.log(`[agent-wallet] network=${AGENT_NETWORK} horizon=${HORIZON_URL} api=${API_URL}`);

const server = new StellarSdk.Horizon.Server(HORIZON_URL);

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getOrCreateKeypair(state) {
  if (state.secretKey) {
    return StellarSdk.Keypair.fromSecret(state.secretKey);
  }
  const kp = StellarSdk.Keypair.random();
  state.secretKey = kp.secret();
  state.publicKey = kp.publicKey();
  saveState(state);
  console.log('Generated new keypair for Juanita Tienda.');
  return kp;
}

async function apiPost(path, body, token) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${data.error ?? data.message ?? JSON.stringify(data)}`);
  }
  return data;
}

/** Challenge/sign/token login — same flow as Login.tsx / api.ts#getAuthToken. */
async function login(state, keypair) {
  const { challenge } = await apiPost('/auth/challenge', { stellar_address: keypair.publicKey() });
  const signature = keypair.sign(Buffer.from(challenge, 'utf8')).toString('base64');
  const { token } = await apiPost('/auth/token', {
    stellar_address: keypair.publicKey(),
    challenge,
    signature,
  });
  state.token = token;
  saveState(state);
  return token;
}

async function cmdRegister(usernameArg) {
  const state = loadState();
  const keypair = getOrCreateKeypair(state);
  const username = usernameArg || state.username || DEFAULT_USERNAME;

  const { user, token } = await apiPost('/users/register', {
    stellar_address: keypair.publicKey(),
    username,
  });

  state.username = username;
  state.userId = user.id;
  state.token = token;
  saveState(state);

  console.log(`Registered Juanita Tienda (${username})`);
  console.log(`  user id:    ${user.id}`);
  console.log(`  public key: ${keypair.publicKey()}`);
  console.log(`  explorer:   https://stellar.expert/explorer/testnet/account/${keypair.publicKey()}`);
}

async function cmdLogin() {
  const state = loadState();
  const keypair = getOrCreateKeypair(state);
  await login(state, keypair);
  console.log('Logged in. Token saved to .agent-wallet/juanita.json');
}

async function cmdWhoami() {
  const state = loadState();
  if (!state.secretKey) {
    console.log('No keypair yet — run `register` first.');
    return;
  }
  const keypair = StellarSdk.Keypair.fromSecret(state.secretKey);
  console.log(`username:   ${state.username ?? '(not registered)'}`);
  console.log(`user id:    ${state.userId ?? '(not registered)'}`);
  console.log(`public key: ${keypair.publicKey()}`);

  try {
    const account = await server.loadAccount(keypair.publicKey());
    console.log('balances:');
    for (const b of account.balances) {
      const code = b.asset_type === 'native' ? 'XLM' : b.asset_code;
      console.log(`  ${code}: ${b.balance}`);
    }
  } catch {
    console.log('account not yet funded on-chain.');
  }
}

/** Ensure a classic trustline exists for the given asset, signing locally. */
async function cmdTrustline(assetCode, issuer) {
  if (!assetCode || !issuer) {
    throw new Error('Usage: agent-wallet.mjs trustline <ASSET_CODE> <ISSUER>');
  }
  const state = loadState();
  const keypair = getOrCreateKeypair(state);
  const asset = new StellarSdk.Asset(assetCode, issuer);

  const account = await server.loadAccount(keypair.publicKey());
  const exists = account.balances.some(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
  if (exists) {
    console.log(`Trustline for ${assetCode} already exists.`);
    return;
  }

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();
  tx.sign(keypair);

  const result = await server.submitTransaction(tx);
  console.log(`Trustline for ${assetCode} created. tx: ${result.hash}`);
}

/**
 * Release a trade: prepare the release() XDR from the backend, sign it
 * locally (the contract requires buyer.require_auth()), submit it back.
 * Mirrors api.ts#completeTrade exactly.
 */
async function cmdRelease(tradeId) {
  if (!tradeId) throw new Error('Usage: agent-wallet.mjs release <tradeId>');
  const state = loadState();
  const keypair = getOrCreateKeypair(state);
  let token = state.token;
  if (!token) token = await login(state, keypair);

  let prepared;
  try {
    prepared = await apiPost(`/trades/${tradeId}/complete/prepare`, {}, token);
  } catch (err) {
    if (String(err.message).includes('(401)')) {
      token = await login(state, keypair);
      prepared = await apiPost(`/trades/${tradeId}/complete/prepare`, {}, token);
    } else {
      throw err;
    }
  }

  if (prepared.mock) {
    console.log('Backend is running with MOCK_STELLAR=true — submitting without a signature.');
    const result = await apiPost(`/trades/${tradeId}/complete`, {}, token);
    console.log(`Release submitted (mock). tx: ${result.release_tx_hash}`);
    return;
  }

  const tx = StellarSdk.TransactionBuilder.fromXDR(prepared.xdr, prepared.network_passphrase);
  tx.sign(keypair);
  const signedXdr = tx.toXDR();

  const result = await apiPost(`/trades/${tradeId}/complete`, { signed_xdr: signedXdr }, token);
  console.log(`Release confirmed on-chain. tx: ${result.release_tx_hash}`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'register':
      return cmdRegister(args[0]);
    case 'login':
      return cmdLogin();
    case 'whoami':
      return cmdWhoami();
    case 'trustline':
      return cmdTrustline(args[0], args[1]);
    case 'release':
      return cmdRelease(args[0]);
    default:
      console.log(__filename_usage());
      process.exit(1);
  }
}

function __filename_usage() {
  return [
    'Usage:',
    '  node micopay/backend/scripts/agent-wallet.mjs register [username]',
    '  node micopay/backend/scripts/agent-wallet.mjs login',
    '  node micopay/backend/scripts/agent-wallet.mjs whoami',
    '  node micopay/backend/scripts/agent-wallet.mjs trustline <ASSET_CODE> <ISSUER>',
    '  node micopay/backend/scripts/agent-wallet.mjs release <tradeId>',
  ].join('\n');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
