import { Keypair, TransactionBuilder, Operation, Memo, Networks, Asset, Horizon } from '@stellar/stellar-sdk';
import { requireUserPresence } from '../lib/userPresence';
import { exportSecretKey } from '../lib/keystore';
import { Buffer } from 'buffer';
import { buildTxUrl } from '../utils/stellarExplorer';

const HORIZON_URL = import.meta.env.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

const server = new Horizon.Server(HORIZON_URL);

export async function sendCETESToEtherfuse(
  cetesAmount: string,
  withdrawAnchorAccount: string,
  withdrawMemo: string,
  cetesIssuer: string
): Promise<{ hash: string; explorerUrl: string }> {
  // Mueve dinero: se confirma antes de tocar la llave.
  await requireUserPresence('payment');
  const secret = await exportSecretKey();
  if (!secret) throw new Error("No se encontró la llave privada del dispositivo.");

  const keypair = Keypair.fromSecret(secret);
  
  const account = await server.loadAccount(keypair.publicKey());

  const memoBuffer = Buffer.from(withdrawMemo, 'base64');
  const memo = Memo.hash(memoBuffer);

  const asset = new Asset('CETES', cetesIssuer);

  const tx = new TransactionBuilder(account, {
    fee: '10000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: withdrawAnchorAccount,
        asset: asset,
        amount: cetesAmount,
      })
    )
    .setTimeout(90)
    .addMemo(memo)
    .build();

  tx.sign(keypair);

  try {
    const response = await server.submitTransaction(tx);
    return {
      hash: response.hash,
      explorerUrl: buildTxUrl(response.hash)
    };
  } catch (error: any) {
    if (error?.response?.data?.extras?.result_codes?.transaction === 'tx_too_late') {
      throw new Error('tx_too_late');
    }
    throw error;
  }
}