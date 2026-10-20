/**
 * Prueba de humo contra un backend desplegado (por defecto api.micopay.app,
 * que corre en testnet): un retiro completo con el agente demo, sin telefono.
 *
 * Un cliente desechable (friendbot + trustline + USDC de pruebas) crea un
 * retiro con agente_demo_rgjo, bloquea, muestra su QR; el agente confirma la
 * entrega y libera, igual que haria el bot leyendo la pantalla. Antes, el
 * agente recibe la trustline de USDC si le falta.
 *
 * Uso (desde micopay/backend):
 *   ASSET=USDC npx tsx scripts/ensayo-usdc/humo.ts
 * Requiere ~/.micopay/demo-agent.json (bot.ts) y ~/.micopay/ensayo-usdc.json (emisor).
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = process.env.MICOPAY_API ?? 'https://api.micopay.app';
const ASSET = (process.env.ASSET ?? 'USDC').toUpperCase();
const AMOUNT_MXN = Number(process.env.AMOUNT_MXN ?? 200);
const server = new Horizon.Server('https://horizon-testnet.stellar.org');

const agentState = JSON.parse(readFileSync(join(homedir(), '.micopay', 'demo-agent.json'), 'utf8'));
const issuer = Keypair.fromSecret(JSON.parse(readFileSync(join(homedir(), '.micopay', 'ensayo-usdc.json'), 'utf8')).issuer);
const usdc = new Asset('USDC', issuer.publicKey());

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString('es-MX')}] ${msg}`);
}

async function submit(kp: Keypair, ops: any[]) {
  const account = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: '10000', networkPassphrase: Networks.TESTNET });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(kp);
  return server.submitTransaction(tx);
}

async function hasTrust(pub: string) {
  const acc = await server.loadAccount(pub);
  return acc.balances.some((b: any) => b.asset_code === 'USDC' && b.asset_issuer === usdc.issuer);
}

async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.code ?? ''} ${data.message ?? text}`);
  return data as T;
}

async function challenge(kp: Keypair) {
  const { challenge } = await api<{ challenge: string }>('POST', '/auth/challenge', { stellar_address: kp.publicKey() });
  return { challenge, signature: kp.sign(Buffer.from(challenge, 'utf8')).toString('base64') };
}

async function login(kp: Keypair) {
  const { token } = await api<{ token: string }>('POST', '/auth/token', { stellar_address: kp.publicKey(), ...(await challenge(kp)) });
  return token;
}

function sign(kp: Keypair, prepared: { xdr: string; network_passphrase: string }) {
  const tx = TransactionBuilder.fromXDR(prepared.xdr, prepared.network_passphrase);
  tx.sign(kp);
  return tx.toXDR();
}

async function main() {
  const agent = Keypair.fromSecret(agentState.secret);
  if (ASSET === 'USDC' && !(await hasTrust(agent.publicKey()))) {
    await submit(agent, [Operation.changeTrust({ asset: usdc })]);
    log('Trustline de USDC creada para el agente demo.');
  }

  const customer = Keypair.random();
  log(`Cliente desechable ${customer.publicKey()}`);
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${customer.publicKey()}`);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  if (ASSET === 'USDC') {
    await submit(customer, [Operation.changeTrust({ asset: usdc })]);
    await submit(issuer, [Operation.payment({ destination: customer.publicKey(), asset: usdc, amount: '100' })]);
  }
  await api('POST', '/users/register', {
    stellar_address: customer.publicKey(),
    username: `humo_${customer.publicKey().slice(-6).toLowerCase()}`,
    ...(await challenge(customer)),
  });
  const customerToken = await login(customer);
  const agentToken = await login(agent);

  const me = await api('GET', '/users/me', undefined, agentToken);
  const agentId = me.user?.id ?? me.id;
  await api('PATCH', '/users/me/availability', { availability: 'online' }, agentToken);

  const { trade } = await api('POST', '/trades', { counterparty_id: agentId, amount_mxn: AMOUNT_MXN, flow: 'cashout', asset_code: ASSET }, customerToken);
  log(`Operacion ${trade.id}: ${trade.asset_code}, tasa ${trade.rate_mxn}`);

  const lockPrep = await api('POST', `/trades/${trade.id}/lock/prepare`, {}, customerToken);
  const locked = await api('POST', `/trades/${trade.id}/lock`, { signed_xdr: sign(customer, lockPrep) }, customerToken);
  log(`lock ${locked.lock_tx_hash}`);

  await api('POST', `/trades/${trade.id}/reveal`, undefined, customerToken);
  const { qr_payload } = await api('GET', `/trades/${trade.id}/secret`, undefined, customerToken);
  const claim = new URL(qr_payload).searchParams.get('claim_token');
  await api('POST', `/trades/${trade.id}/merchant-confirm`, { claim_token: claim }, agentToken);

  const relPrep = await api('POST', `/trades/${trade.id}/complete/prepare`, {}, agentToken);
  const done = await api('POST', `/trades/${trade.id}/complete`, { signed_xdr: sign(agent, relPrep) }, agentToken);
  log(`release ${done.release_tx_hash} · estado ${done.status}`);
  log(`https://stellar.expert/explorer/testnet/tx/${done.release_tx_hash}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
