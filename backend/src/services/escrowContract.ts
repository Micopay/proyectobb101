import { config } from '../config.js';
import { BadRequestError } from '../utils/errors.js';

/**
 * El contrato del escrow de una operacion. Cada activo tiene su instancia
 * (`ESCROW_CONTRACTS`), y la operacion congela la suya al crearse
 * (`escrow_contract_id`): lock, release y refund van siempre al contrato donde
 * se pacto, aunque despues cambie la configuracion. Las operaciones anteriores
 * a esa columna van a `ESCROW_LEGACY_CONTRACT_ID` si esta definido, y si no al
 * contrato de su activo.
 */
export function escrowContractForTrade(trade: { escrow_contract_id?: string | null; asset_code?: string | null }): string {
  if (trade.escrow_contract_id) return trade.escrow_contract_id;
  if (config.escrowLegacyContractId) return config.escrowLegacyContractId;
  const byAsset = trade.asset_code ? config.escrowContracts[trade.asset_code.toUpperCase()] : undefined;
  const contractId = byAsset ?? config.escrowContractId;
  if (!contractId) {
    throw new BadRequestError('ESCROW_NOT_CONFIGURED', 'Esta operacion no tiene un contrato de escrow disponible.', `No escrow contract for asset ${trade.asset_code ?? '(none)'}`);
  }
  return contractId;
}
