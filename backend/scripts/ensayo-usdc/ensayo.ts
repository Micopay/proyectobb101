/**
 * Ensayo en TESTNET de un retiro completo con un activo emitido, antes de mover
 * USDC real en mainnet.
 *
 * El escrow de mainnet bloquea USDC (activo emitido: trustlines, SAC propio),
 * mientras que el de testnet siempre ha bloqueado XLM nativo. Este ensayo emite
 * un "USDC" propio en testnet para recorrer exactamente los caminos que mainnet
 * usa y testnet nunca toco: trustline del agente y de la plataforma, lock y
 * release de un token emitido, y la conversion con la tasa usdc-mxn.
 *
 * Uso (desde micopay/backend):
 *   npx tsx scripts/ensayo-usdc/ensayo.ts chain   cuentas, emisor y SAC
 *   (desplegar el escrow con contracts/deploy-mainnet.sh y las variables
 *    que imprime `chain`, y arrancar el backend local con ESCROW_ASSET=USDC)
 *   npx tsx scripts/ensayo-usdc/ensayo.ts flow    el retiro por la API
 *   ASSET=XLM npx tsx scripts/ensayo-usdc/ensayo.ts flow   el mismo retiro en XLM
 *   (con ESCROW_CONTRACTS=USDC=...,XLM=... los dos van al mismo backend)
 *   npx tsx scripts/ensayo-usdc/ensayo.ts deposit  un deposito (el otro flujo)
 *   npx tsx scripts/ensayo-usdc/ensayo.ts fund G... 100   manda USDC de pruebas
 *
 * El estado (llaves de testnet desechables) vive en ~/.micopay/ensayo-usdc.json.
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pg from 'pg';

const API = process.env.MICOPAY_API ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET_KEY ?? '';
const HORIZON = 'https://horizon-testnet.stellar.org';
const STATE_FILE = join(homedir(), '.micopay', 'ensayo-usdc.json');
const LAT = 19.4326;
const LNG = -99.1332;
const AMOUNT_MXN = 500;
/** Activo del retiro: USDC (emitido, el caso de mainnet) o XLM. */
const ASSET = (process.env.ASSET ?? 'USDC').toUpperCase();

type State = { issuer: string; customer: string; agent: string; sac?: string };
const server = new Horizon.Server(HORIZON);

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString('es-MX')}] ${msg}`);
}

async function friendbot(pub: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}`);
}

async function submit(kp: Keypair, ops: any[]) {
  const account = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: '10000', networkPassphrase: Networks.TESTNET });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(kp);
  return server.submitTransaction(tx);
}

async function balanceOf(pub: string, asset: Asset): Promise<string> {
  const acc = await server.loadAccount(pub);
  const b = asset.isNative()
    ? acc.balances.find((x: any) => x.asset_type === 'native')
    : acc.balances.find((x: any) => x.asset_code === asset.code && x.asset_issuer === asset.issuer);
  return (b as any)?.balance ?? '(sin trustline)';
}

async function chain() {
  if (!PLATFORM_SECRET) throw new Error('Falta PLATFORM_SECRET_KEY (la cuenta de plataforma del ensayo).');
  const platform = Keypair.fromSecret(PLATFORM_SECRET);
  const issuer = Keypair.random();
  const customer = Keypair.random();
  const agent = Keypair.random();
  const usdc = new Asset('USDC', issuer.publicKey());

  log('Fondeando emisor, cliente y agente con friendbot…');
  await Promise.all([friendbot(issuer.publicKey()), friendbot(customer.publicKey()), friendbot(agent.publicKey())]);

  log('Trustlines de USDC (cliente, agente, plataforma)…');
  for (const kp of [customer, agent, platform]) await submit(kp, [Operation.changeTrust({ asset: usdc })]);

  log('El emisor manda 1000 USDC al cliente…');
  await submit(issuer, [Operation.payment({ destination: customer.publicKey(), asset: usdc, amount: '1000' })]);

  log('Desplegando el SAC del USDC del ensayo…');
  const sac = execFileSync('stellar', [
    'contract', 'asset', 'deploy', '--asset', `USDC:${issuer.publicKey()}`, '--source-account', PLATFORM_SECRET,
    '--rpc-url', 'https://soroban-testnet.stellar.org', '--network-passphrase', Networks.TESTNET,
  ], { encoding: 'utf8' }).trim().split('\n').pop()!.trim();

  const state: State = { issuer: issuer.secret(), customer: customer.secret(), agent: agent.secret(), sac };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`SAC: ${sac}`);
  log('Siguiente: desplegar el escrow con estas variables (desde micopay/contracts):');
  console.log(`  USDC_ASSET=USDC:${issuer.publicKey()} USDC_SAC=${sac} \\`);
  console.log('  RPC_URL=https://soroban-testnet.stellar.org PASSPHRASE="Test SDF Network ; September 2015" \\');
  console.log('  HORIZON=https://horizon-testnet.stellar.org SOURCE=<alias de la plataforma> bash deploy-mainnet.sh');
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

async function registerAndLogin(kp: Keypair, username: string): Promise<string> {
  try {
    await api('POST', '/users/register', { stellar_address: kp.publicKey(), username, ...(await challenge(kp)) });
  } catch (e: any) {
    if (!String(e.message).includes('409')) throw e; // ya registrado
  }
  const { token } = await api<{ token: string }>('POST', '/auth/token', { stellar_address: kp.publicKey(), ...(await challenge(kp)) });
  return token;
}

function sign(kp: Keypair, prepared: { xdr: string; network_passphrase: string }) {
  const tx = TransactionBuilder.fromXDR(prepared.xdr, prepared.network_passphrase);
  tx.sign(kp);
  return tx.toXDR();
}

async function flow() {
  if (!existsSync(STATE_FILE)) throw new Error('Primero corre `chain`.');
  if (!DATABASE_URL) throw new Error('Falta DATABASE_URL (la misma base del backend local).');
  const s: State = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const customer = Keypair.fromSecret(s.customer);
  const agent = Keypair.fromSecret(s.agent);
  const usdc = ASSET === 'XLM' ? Asset.native() : new Asset('USDC', Keypair.fromSecret(s.issuer).publicKey());
  const platformPub = Keypair.fromSecret(PLATFORM_SECRET).publicKey();

  const before = {
    customer: await balanceOf(customer.publicKey(), usdc),
    agent: await balanceOf(agent.publicKey(), usdc),
    platform: await balanceOf(platformPub, usdc),
  };
  log(`Saldos antes: ${JSON.stringify(before)}`);

  const agentName = `ensayo_agente_${agent.publicKey().slice(-4).toLowerCase()}`;
  const agentToken = await registerAndLogin(agent, agentName);
  const customerToken = await registerAndLogin(customer, `ensayo_cliente_${customer.publicKey().slice(-4).toLowerCase()}`);

  log('Agente: ubicacion, limites y alta en la Red…');
  await api('PATCH', '/merchants/me/location', { latitude: LAT, longitude: LNG, area_label: 'Ensayo', meeting_point: 'Ensayo' }, agentToken);
  await api('PUT', '/merchants/me/config', { rate_percent: 1, min_trade_mxn: 100, max_trade_mxn: 50000, daily_cap_mxn: 250000 }, agentToken);
  await api('POST', '/merchants/me/enroll', {}, agentToken);

  // El KYC de Didit no existe en el ensayo: se marca directo en la base, igual
  // que se activo agente_demo_rgjo en produccion.
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(`UPDATE users SET kyc_provider = 'didit', kyc_level = 1 WHERE stellar_address = $1`, [agent.publicKey()]);
  await db.end();
  await api('POST', '/merchants/me/activate', {}, agentToken);
  await api('PATCH', '/users/me/availability', { availability: 'online' }, agentToken);

  log(`Cliente: busca agentes y crea el retiro en ${ASSET}…`);
  const { merchants } = await api('GET', `/merchants/available?lat=${LAT}&lng=${LNG}&amount_mxn=${AMOUNT_MXN}&flow=cashout`);
  const merchant = merchants.find((m: any) => m.username === agentName) ?? merchants[0];
  if (!merchant) throw new Error('No aparecio ningun agente.');
  const { trade } = await api('POST', '/trades', { counterparty_id: merchant.seller_id, amount_mxn: AMOUNT_MXN, flow: 'cashout', asset_code: ASSET }, customerToken);
  log(`Operacion ${trade.id}: ${trade.asset_code}, tasa ${trade.rate_mxn}, stroops ${trade.amount_stroops ?? '?'}`);

  log('Cliente: bloquea (firma con su llave)…');
  const lockPrep = await api('POST', `/trades/${trade.id}/lock/prepare`, {}, customerToken);
  const locked = await api('POST', `/trades/${trade.id}/lock`, { signed_xdr: sign(customer, lockPrep) }, customerToken);
  log(`  lock ${locked.lock_tx_hash}`);

  log('Cliente: muestra su QR…');
  await api('POST', `/trades/${trade.id}/reveal`, undefined, customerToken);
  const { qr_payload } = await api('GET', `/trades/${trade.id}/secret`, undefined, customerToken);
  const claim = new URL(qr_payload).searchParams.get('claim_token');

  log('Agente: escanea, entrega el efectivo y libera…');
  await api('POST', `/trades/${trade.id}/merchant-confirm`, { claim_token: claim }, agentToken);
  const relPrep = await api('POST', `/trades/${trade.id}/complete/prepare`, {}, agentToken);
  const done = await api('POST', `/trades/${trade.id}/complete`, { signed_xdr: sign(agent, relPrep) }, agentToken);
  log(`  release ${done.release_tx_hash} · estado ${done.status}`);

  const after = {
    customer: await balanceOf(customer.publicKey(), usdc),
    agent: await balanceOf(agent.publicKey(), usdc),
    platform: await balanceOf(platformPub, usdc),
  };
  log(`Saldos despues: ${JSON.stringify(after)}`);
  log(`https://stellar.expert/explorer/testnet/tx/${done.release_tx_hash}`);
}

/**
 * El otro flujo: un DEPOSITO. El cliente entrega efectivo; el agente bloquea
 * el activo, confirma que recibio los billetes (reveal) y el cliente libera
 * hacia su saldo. Requiere haber corrido `flow` antes (agente ya dado de alta).
 */
async function deposit() {
  if (!existsSync(STATE_FILE)) throw new Error('Primero corre `chain` y `flow`.');
  const s: State = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const customer = Keypair.fromSecret(s.customer);
  const agent = Keypair.fromSecret(s.agent);
  const usdc = ASSET === 'XLM' ? Asset.native() : new Asset('USDC', Keypair.fromSecret(s.issuer).publicKey());
  const platformPub = Keypair.fromSecret(PLATFORM_SECRET).publicKey();
  const balances = async () => ({
    customer: await balanceOf(customer.publicKey(), usdc),
    agent: await balanceOf(agent.publicKey(), usdc),
    platform: await balanceOf(platformPub, usdc),
  });
  log(`Saldos antes: ${JSON.stringify(await balances())}`);

  const agentName = `ensayo_agente_${agent.publicKey().slice(-4).toLowerCase()}`;
  const agentToken = await registerAndLogin(agent, agentName);
  const customerToken = await registerAndLogin(customer, `ensayo_cliente_${customer.publicKey().slice(-4).toLowerCase()}`);
  const { merchants } = await api('GET', `/merchants/available?lat=${LAT}&lng=${LNG}&amount_mxn=${AMOUNT_MXN}&flow=deposit`);
  const merchant = merchants.find((m: any) => m.username === agentName);
  if (!merchant) throw new Error('El agente del ensayo no aparecio; corre `flow` primero.');
  log(`Mapa: entregas $${merchant.client_pays_mxn}, recibes $${merchant.client_receives_mxn}`);

  const { trade } = await api('POST', '/trades', { counterparty_id: merchant.seller_id, amount_mxn: AMOUNT_MXN, flow: 'deposit', asset_code: ASSET }, customerToken);
  log(`Operacion ${trade.id}: ${trade.asset_code}, tasa ${trade.rate_mxn}, escrow $${trade.escrow_amount_mxn}`);

  log('Agente: bloquea…');
  const lockPrep = await api('POST', `/trades/${trade.id}/lock/prepare`, {}, agentToken);
  const locked = await api('POST', `/trades/${trade.id}/lock`, { signed_xdr: sign(agent, lockPrep) }, agentToken);
  log(`  lock ${locked.lock_tx_hash}`);

  log('Agente: recibio los billetes (reveal)…');
  await api('POST', `/trades/${trade.id}/reveal`, undefined, agentToken);

  log('Cliente: libera hacia su saldo…');
  const relPrep = await api('POST', `/trades/${trade.id}/complete/prepare`, {}, customerToken);
  const done = await api('POST', `/trades/${trade.id}/complete`, { signed_xdr: sign(customer, relPrep) }, customerToken);
  log(`  release ${done.release_tx_hash} · estado ${done.status}`);
  log(`Saldos despues: ${JSON.stringify(await balances())}`);
}

/**
 * Manda USDC de pruebas (testnet) a una billetera, p. ej. la del telefono de la
 * demo. La billetera debe haber activado USDC antes (Recibir -> Activar USDC).
 */
async function fund(destination?: string, amount = '100') {
  if (!destination) throw new Error('Uso: ensayo.ts fund <direccion G...> [monto]');
  if (!existsSync(STATE_FILE)) throw new Error('Primero corre `chain`.');
  const s: State = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const issuer = Keypair.fromSecret(s.issuer);
  const usdc = new Asset('USDC', issuer.publicKey());
  const before = await balanceOf(destination, usdc).catch(() => '(cuenta sin fondos)');
  if (before === '(sin trustline)' || before === '(cuenta sin fondos)') {
    throw new Error(`La billetera ${destination} no puede recibir USDC: ${before}. Activalo en la app (Recibir).`);
  }
  const res = await submit(issuer, [Operation.payment({ destination, asset: usdc, amount })]);
  log(`Enviados ${amount} USDC. Saldo: ${before} -> ${await balanceOf(destination, usdc)}`);
  log(`https://stellar.expert/explorer/testnet/tx/${res.hash}`);
}

const cmd = process.argv[2];
(cmd === 'chain' ? chain()
  : cmd === 'flow' ? flow()
  : cmd === 'deposit' ? deposit()
  : cmd === 'fund' ? fund(process.argv[3], process.argv[4])
  : Promise.reject(new Error('Uso: ensayo.ts chain|flow|deposit|fund')))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
