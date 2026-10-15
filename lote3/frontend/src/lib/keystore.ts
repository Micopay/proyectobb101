import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { readJSON, writeJSON, removeKey } from '../services/secureStorage';
import { requireUserPresence, type PresenceReason } from './userPresence';

const KEYPAIR_KEY = 'stellar_keypair';

interface StoredKeypair {
    publicKey: string;
    secretKey: string; // never leaves this module via HTTP
}

export async function generateAndStoreKeypair(): Promise<string> {
    const kp = Keypair.random();
    await writeJSON(KEYPAIR_KEY, {
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
    });
    return kp.publicKey();
}

export async function getPublicKey(): Promise<string | null> {
    const stored = await readJSON<StoredKeypair>(KEYPAIR_KEY);
    return stored?.publicKey ?? null;
}

export async function keypairExists(): Promise<boolean> {
    const stored = await readJSON<StoredKeypair>(KEYPAIR_KEY);
    return stored !== null && !!stored.secretKey;
}

export async function signChallenge(challenge: string): Promise<string> {
    const stored = await readJSON<StoredKeypair>(KEYPAIR_KEY);
    if (!stored?.secretKey) throw new Error('No keypair — call generateAndStoreKeypair first');
    const kp = Keypair.fromSecret(stored.secretKey);
    const sig = kp.sign(Buffer.from(challenge, 'utf8'));
    return sig.toString('base64');
}

/**
 * Sign a backend-prepared transaction XDR locally and return the signed XDR.
 * Used for Soroban contract calls (e.g. escrow lock/release) where the
 * contract's require_auth() must be satisfied by the device's own key —
 * the secret key never leaves this module.
 */
export async function signTransactionXdr(
    xdr: string,
    networkPassphrase: string,
    reason: PresenceReason = 'sign_request',
): Promise<string> {
    // La compuerta va DENTRO, no en cada llamador: esta funcion firma
    // transacciones que mueven dinero, y un llamador nuevo que se olvide de
    // pedir confirmacion volveria a abrir el hueco en silencio.
    await requireUserPresence(reason);
    const stored = await readJSON<StoredKeypair>(KEYPAIR_KEY);
    if (!stored?.secretKey) throw new Error('No keypair — call generateAndStoreKeypair first');
    const kp = Keypair.fromSecret(stored.secretKey);
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(kp);
    return tx.toXDR();
}

export async function importKeypair(secretKey: string): Promise<string> {
    const kp = Keypair.fromSecret(secretKey); // throws on bad input
    await writeJSON(KEYPAIR_KEY, {
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
    });
    return kp.publicKey();
}

/**
 * Devuelve la llave secreta SIN pedir confirmacion.
 *
 * No lleva compuerta a proposito: varias rutas la usan para derivar la clave
 * publica o firmar operaciones internas, y pedir huella para consultar un saldo
 * enseñaria a la gente a confirmar sin leer.
 *
 * Para enseñarsela a la persona, usar `revealSecretKey()`.
 */
export async function exportSecretKey(): Promise<string> {
    const stored = await readJSON<StoredKeypair>(KEYPAIR_KEY);
    if (!stored?.secretKey) throw new Error('No keypair stored');
    return stored.secretKey;
}

/**
 * La llave para MOSTRARSELA a la persona (respaldo). Siempre pregunta, y sin
 * ventana de gracia: es el secreto de mayor valor del sistema y quien la ve
 * puede vaciar la cuenta desde cualquier otro dispositivo.
 */
export async function revealSecretKey(): Promise<string> {
    await requireUserPresence('reveal_key', true);
    return exportSecretKey();
}

export async function deleteKeypair(): Promise<void> {
    await removeKey(KEYPAIR_KEY);
}