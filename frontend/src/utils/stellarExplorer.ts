// stellar.expert uses "public" (not "mainnet") as the network segment for mainnet.
const STELLAR_NETWORK = (import.meta.env.VITE_STELLAR_NETWORK || 'TESTNET').toUpperCase();
const EXPLORER_NETWORK_SEGMENT = STELLAR_NETWORK === 'PUBLIC' || STELLAR_NETWORK === 'MAINNET' ? 'public' : 'testnet';

/** Nombre de la red para la UI: "Mainnet" o "Testnet". */
export const STELLAR_NETWORK_LABEL = EXPLORER_NETWORK_SEGMENT === 'public' ? 'Mainnet' : 'Testnet';
const STELLAR_EXPLORER_BASE = `https://stellar.expert/explorer/${EXPLORER_NETWORK_SEGMENT}/tx`;

export function buildTxUrl(txHash: string): string {
  return `${STELLAR_EXPLORER_BASE}/${txHash}`;
}

export function truncateHash(hash: string, chars = 8): string {
  return hash.length > chars * 2
    ? hash.substring(0, chars) + '…'
    : hash;
}
