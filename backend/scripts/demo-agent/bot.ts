/**
 * Agente de demostracion de MicoPay.
 *
 * Hace el papel del agente de la Red MicoPay para poder mostrar una operacion
 * completa con un solo telefono:
 *   - Retiro (cashout): el cliente bloquea y muestra su QR. El bot toma una
 *     captura del telefono por adb, lee el QR, confirma la entrega y libera
 *     los fondos firmando con su propia llave.
 *   - Deposito: el bot bloquea la cripto y confirma que recibio el efectivo.
 *     El cliente termina desde su pantalla.
 *
 * Uso (desde micopay/backend):
 *   npx tsx scripts/demo-agent/bot.ts setup [lat lng]   crea y configura la cuenta
 *   npx tsx scripts/demo-agent/bot.ts run               atiende operaciones
 *   npx tsx scripts/demo-agent/bot.ts status            muestra cuenta y operaciones
 *
 * La llave del bot vive en ~/.micopay/demo-agent.json, fuera del repo. La cuenta
 * queda en `pending_verification` tras el setup: activarla requiere KYC de
 * Didit, asi que se activa aparte en la base de datos.
 *
 * Mainnet: `MICOPAY_NETWORK=mainnet`. La llave va en demo-agent-mainnet.json y
 * no hay friendbot: el setup imprime la direccion para fondearla con XLM y, ya
 * fondeada, crea la trustline de USDC (el bot recibe USDC en el release).
 * En testnet, `USDC_ISSUER=G...` hace lo mismo con el USDC del escrow de testnet.
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.MICOPAY_API ?? 'https://api.micopay.app';
const MAINNET = (process.env.MICOPAY_NETWORK ?? 'testnet').toLowerCase() === 'mainnet';
const STATE_FILE = join(homedir(), '.micopay', MAINNET ? 'demo-agent-mainnet.json' : 'demo-agent.json');
const HORIZON = MAINNET ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
const EXPLORER = `https://stellar.expert/explorer/${MAINNET ? 'public' : 'testnet'}/tx`;
// Emisor del USDC que recibe el bot en el release. En mainnet, Circle; en
// testnet solo si se define USDC_ISSUER (el del escrow USDC de testnet).
const USDC_ISSUER = process.env.USDC_ISSUER ?? (MAINNET ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' : '');
const USDC = USDC_ISSUER ? new Asset('USDC', USDC_ISSUER) : null;
const ADB = process.env.ADB ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const QR_HELPER = join(dirname(fileURLToPath(import.meta.url)), 'qr_from_phone.py');
const POLL_MS = 3000;

type State = { secret: string; public: string; username: string };

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString('es-MX')}] ${msg}`);
}

function loadState(): State | null {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
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
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${data.code ?? ''} ${data.message ?? text}`);
    (err as any).status = res.status;
    (err as any).code = data.code;
    throw err;
  }
  return data as T;
}

async function signedChallenge(kp: Keypair) {
  const { challenge } = await api<{ challenge: string }>('POST', '/auth/challenge', {
    stellar_address: kp.publicKey(),
  });
  return { challenge, signature: kp.sign(Buffer.from(challenge, 'utf8')).toString('base64') };
}

async function login(kp: Keypair): Promise<string> {
  const { challenge, signature } = await signedChallenge(kp);
  const { token } = await api<{ token: string }>('POST', '/auth/token', {
    stellar_address: kp.publicKey(),
    challenge,
    signature,
  });
  return token;
}

function signXdr(kp: Keypair, prepared: { xdr: string; network_passphrase: string }) {
  const tx = TransactionBuilder.fromXDR(prepared.xdr, prepared.network_passphrase);
  tx.sign(kp);
  return tx.toXDR();
}

/** Ultima ubicacion conocida del telefono, para poner al agente a su lado. */
function phoneLocation(): { lat: number; lng: number } | null {
  try {
    const out = execFileSync(ADB, ['shell', 'dumpsys', 'location'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const m = out.match(/last location=Location\[\w+ (-?\d+\.\d+),(-?\d+\.\d+)/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

async function setup(argLat?: string, argLng?: string) {
  let state = loadState();
  const kp = state ? Keypair.fromSecret(state.secret) : Keypair.random();

  if (!state) {
    const username = `agente_demo_${kp.publicKey().slice(-4).toLowerCase()}`;
    if (!MAINNET) {
      log(`Fondeando ${kp.publicKey()} con friendbot…`);
      const fb = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
      if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
    }

    const { challenge, signature } = await signedChallenge(kp);
    await api('POST', '/users/register', { stellar_address: kp.publicKey(), username, challenge, signature });
    state = { secret: kp.secret(), public: kp.publicKey(), username };
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log(`Cuenta registrada: ${username}`);
  }

  if (USDC && !(await ensureUsdcTrustline(kp, USDC))) return;

  const token = await login(kp);
  const pos = argLat && argLng ? { lat: Number(argLat), lng: Number(argLng) } : phoneLocation();
  if (!pos) throw new Error('No hay ubicacion: pasa lat y lng, o conecta el telefono por USB.');

  // ~150 m al noreste del punto, para que salga en el mapa como agente cercano.
  await api('PATCH', '/merchants/me/location', {
    latitude: pos.lat + 0.001,
    longitude: pos.lng + 0.001,
    area_label: 'Agente de demostración',
    meeting_point: 'Punto de encuentro de la demo',
  }, token);
  await api('PUT', '/merchants/me/config', {
    rate_percent: 1,
    min_trade_mxn: 100,
    max_trade_mxn: 50000,
    daily_cap_mxn: 250000,
  }, token);
  const readiness = await api('POST', '/merchants/me/enroll', {}, token);
  log(`Ubicación ${(pos.lat + 0.001).toFixed(5)}, ${(pos.lng + 0.001).toFixed(5)} · estado ${readiness.status}`);
  for (const item of readiness.items ?? []) log(`  ${item.done ? '✓' : '✗'} ${item.key}${item.detail ? ` — ${item.detail}` : ''}`);
}

/**
 * Mainnet: la cuenta debe existir (fondeada con XLM) y tener trustline de USDC,
 * o el release no puede pagarle. Devuelve false si aun falta fondearla.
 */
async function ensureUsdcTrustline(kp: Keypair, usdc: Asset): Promise<boolean> {
  const server = new Horizon.Server(HORIZON);
  let account;
  try {
    account = await server.loadAccount(kp.publicKey());
  } catch {
    log(`La cuenta ${kp.publicKey()} no existe en la red.`);
    log('Mándale ~3 XLM y vuelve a correr setup.');
    return false;
  }
  const has = account.balances.some(
    (b: any) => b.asset_code === usdc.code && b.asset_issuer === usdc.issuer,
  );
  if (has) return true;
  const tx = new TransactionBuilder(account, { fee: '10000', networkPassphrase: MAINNET ? Networks.PUBLIC : Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  log(`Trustline de USDC creada. tx ${res.hash}`);
  return true;
}

async function readQrFromPhone(tradeId: string): Promise<string | null> {
  try {
    const text = execFileSync('python', [QR_HELPER, ADB], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
    if (!text) return null;
    const url = new URL(text);
    if (url.protocol !== 'micopay:' || url.hostname !== 'release') return null;
    if (url.searchParams.get('trade_id') !== tradeId) {
      log(`  El QR en pantalla es de otra operación (${url.searchParams.get('trade_id')})`);
      return null;
    }
    return url.searchParams.get('claim_token');
  } catch (e: any) {
    log(`  No se pudo leer la pantalla: ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function release(kp: Keypair, token: string, id: string) {
  const prepared = await api('POST', `/trades/${id}/complete/prepare`, {}, token);
  const body = 'mock' in prepared ? {} : { signed_xdr: signXdr(kp, prepared) };
  const { release_tx_hash } = await api('POST', `/trades/${id}/complete`, body, token);
  log(`  ✅ Fondos liberados. tx ${release_tx_hash}`);
  log(`     ${EXPLORER}/${release_tx_hash}`);
}

async function handleCashout(kp: Keypair, token: string, t: any, done: Set<string>) {
  if (t.status === 'locked') return; // el cliente aun no muestra su QR
  if (t.status !== 'revealing') return;

  // Si ya se escaneo antes (reinicio del bot), merchant-confirm reanuda sin QR.
  let claim = await readQrFromPhone(t.id);
  if (!claim) {
    try {
      await api('POST', `/trades/${t.id}/complete/prepare`, {}, token);
      claim = 'ya-escaneado';
    } catch (e: any) {
      if (e.code !== 'CASH_HANDOFF_REQUIRED') throw e;
      return; // aun no hay QR visible; se reintenta en la siguiente vuelta
    }
  }
  if (claim !== 'ya-escaneado') {
    log(`  QR leído de la pantalla del teléfono. Confirmando entrega de efectivo…`);
    await api('POST', `/trades/${t.id}/merchant-confirm`, { claim_token: claim }, token);
  }
  await release(kp, token, t.id);
  done.add(t.id);
}

async function handleDeposit(kp: Keypair, token: string, t: any, done: Set<string>) {
  if (t.status === 'pending') {
    log(`  Bloqueando la cripto del depósito…`);
    const prepared = await api('POST', `/trades/${t.id}/lock/prepare`, {}, token);
    const body = 'mock' in prepared ? {} : { signed_xdr: signXdr(kp, prepared) };
    const locked = await api('POST', `/trades/${t.id}/lock`, body, token);
    log(`  🔒 Bloqueado. tx ${locked.lock_tx_hash ?? '(sin hash)'}`);
    return;
  }
  if (t.status === 'locked') {
    await api('POST', `/trades/${t.id}/reveal`, {}, token);
    log(`  💵 Efectivo recibido confirmado. El cliente ya puede terminar desde su teléfono.`);
    done.add(t.id);
  }
}

async function run() {
  const state = loadState();
  if (!state) throw new Error('Primero corre: setup');
  const kp = Keypair.fromSecret(state.secret);
  let token = await login(kp);
  let tokenAt = Date.now();
  const done = new Set<string>();
  const seen = new Map<string, string>();

  const readiness = await api('GET', '/merchants/me/readiness', undefined, token);
  log(`Agente ${state.username} (${state.public.slice(0, 6)}…) · estado ${readiness.status}`);
  if (readiness.status !== 'active') log('⚠️  La cuenta no está activa: no aparece en el mapa.');
  log(`Atendiendo operaciones. Ctrl+C para salir.`);

  // Las operaciones que ya existian al arrancar no se tocan.
  const inicial = await api('GET', '/merchants/me/trades?state=all', undefined, token);
  for (const t of inicial.trades) if (['completed', 'cancelled', 'refunded'].includes(t.status)) done.add(t.id);

  for (;;) {
    try {
      if (Date.now() - tokenAt > 6 * 3600_000) { token = await login(kp); tokenAt = Date.now(); }
      const { trades } = await api('GET', '/merchants/me/trades?state=all', undefined, token);
      for (const t of trades) {
        if (done.has(t.id) || ['completed', 'cancelled', 'refunded'].includes(t.status)) continue;
        const key = `${t.status}`;
        if (seen.get(t.id) !== key) {
          seen.set(t.id, key);
          const tipo = t.flow === 'cashout' ? 'RETIRO' : 'DEPÓSITO';
          log(`${tipo} $${t.amount_mxn} de ${t.client_handle} · ${t.status} · ${t.id.slice(0, 8)}`);
        }
        try {
          if (t.flow === 'cashout') await handleCashout(kp, token, t, done);
          else await handleDeposit(kp, token, t, done);
        } catch (e: any) {
          log(`  ❌ ${e.message}`);
        }
      }
    } catch (e: any) {
      log(`Error consultando la bandeja: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function status() {
  const state = loadState();
  if (!state) return log('Sin cuenta. Corre: setup');
  const token = await login(Keypair.fromSecret(state.secret));
  const r = await api('GET', '/merchants/me/readiness', undefined, token);
  log(`${state.username} · ${state.public} · estado ${r.status}`);
  const { trades } = await api('GET', '/merchants/me/trades?state=all', undefined, token);
  for (const t of trades.slice(0, 10)) log(`  ${t.flow} $${t.amount_mxn} ${t.status} ${t.id}`);
}

const [cmd, ...args] = process.argv.slice(2);
const main = cmd === 'setup' ? () => setup(args[0], args[1]) : cmd === 'status' ? status : cmd === 'run' ? run : null;
if (!main) {
  console.log('Uso: npx tsx scripts/demo-agent/bot.ts setup [lat lng] | run | status');
  process.exit(1);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
