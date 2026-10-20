/**
 * WP2 del plan de escrow multiactivo · La UNICA conversion peso -> activo.
 *
 * El peso es la denominacion del acuerdo: dos personas quedan por "quinientos
 * pesos", no por "159.9 XLM". El activo y su tasa son metadata de esa operacion.
 * Aqui vive la traduccion entre ambos, y **nadie mas multiplica**.
 *
 * EL FALLO QUE ESTO ARREGLA (2026-09-05)
 * --------------------------------------
 * El backend hacia `amount_stroops = amount_mxn * 10^7`, es decir, trataba
 * 1 MXN como 1 unidad del activo. Con el escrow bloqueando XLM a ~3.13 MXN,
 * una operacion de 500 pesos bloqueaba 500 XLM = ~1 563 pesos: el cliente
 * entregaba 3.13 veces lo que valia la operacion.
 *
 * No fue un descuido al escribirlo. `contracts/TESTNET.md` etiquetaba el
 * contrato del XLM nativo como "MXNe token contract"; el diagnostico WP0 de
 * julio leyo bien el token en cadena, lo comparo contra esa tabla y concluyo
 * —de forma razonable y equivocada— que el escrow guardaba un peso digital, con
 * lo que la conversion 1:1 parecia correcta. La verificacion fue real; la
 * referencia estaba mal.
 *
 * ARITMETICA
 * ----------
 * Sin floats encadenados. La tasa se escala a entero (7 decimales, igual que
 * los stroops) y toda la division se hace en BigInt. El redondeo es
 * **half-up**, definido aqui una sola vez y probado en los bordes.
 *
 * Se redondea al alza en el empate a proposito: el vendedor bloquea, como mucho,
 * un stroop de mas. Redondear a la baja podria dejar el escrow por debajo de lo
 * pactado, y quedarse corto en dinero ajeno es peor que pasarse por 0.0000001.
 */

import type { FastifyRequest } from 'fastify';
import { AppError, BadRequestError, ValidationError } from '../utils/errors.js';
import { getRateMxn } from '../routes/rate.js';
import { config } from '../config.js';

/** Decimales de un token Soroban estandar (y de XLM). */
const SCALE = 10_000_000n;

export interface AssetConversion {
  /** Cantidad del activo, en stroops (7 decimales). */
  stroops: bigint;
  /** MXN por 1 unidad del activo, congelada en la operacion. */
  rateMxn: string;
  /** De donde salio la tasa, para poder explicarla en una disputa. */
  rateSource: string;
  assetCode: SupportedAsset;
}

/**
 * Activos que el escrow sabe manejar hoy.
 *
 * XLM es el unico desplegado: el contrato `CB4M…` tiene como `TokenId` el
 * Stellar Asset Contract del nativo (verificado en cadena el 2026-09-05, y
 * confirmado ademas porque su `symbol()` devuelve "native").
 *
 * USDC y MXNe entran cuando WP3 despliegue sus instancias. La tabla existe ya
 * para que anadirlos no obligue a tocar la aritmetica, que es la parte delicada.
 */
const ASSETS = {
  XLM: { pair: 'xlm-mxn' as const, fixedRate: null },
  USDC: { pair: 'usdc-mxn' as const, fixedRate: null },
  /** Peso digital: 1 MXNe = 1 MXN por definicion, sin consultar a nadie. */
  MXNE: { pair: null, fixedRate: '1' },
} as const;

export type SupportedAsset = keyof typeof ASSETS;

export function isSupportedAsset(code: string): code is SupportedAsset {
  return Object.prototype.hasOwnProperty.call(ASSETS, code);
}

function toSupportedAsset(raw: string, origin: string): SupportedAsset {
  const code = raw.trim().toUpperCase();
  if (!isSupportedAsset(code)) {
    throw new Error(`${origin} invalido: "${raw}". Valores posibles: ${Object.keys(ASSETS).join(', ')}`);
  }
  return code;
}

/**
 * Los activos con escrow desplegado en esta red: las claves de
 * `ESCROW_CONTRACTS` (cada instancia del contrato guarda un solo token). Un
 * activo desconocido tumba el arranque en vez de aceptar operaciones que
 * ningun contrato podria bloquear.
 */
const DEPLOYED_ESCROW_ASSETS: readonly SupportedAsset[] = Object.keys(config.escrowContracts).map((a) =>
  toSupportedAsset(a, 'ESCROW_CONTRACTS'),
);

/**
 * El activo de una operacion que no lo pide: `ESCROW_ASSET` si tiene contrato,
 * si no el primero desplegado. Con MOCK_STELLAR no hay contratos y se usa
 * `ESCROW_ASSET` tal cual.
 */
export const DEFAULT_ASSET: SupportedAsset = (() => {
  const wanted = toSupportedAsset(config.escrowAsset, 'ESCROW_ASSET');
  if (DEPLOYED_ESCROW_ASSETS.length === 0 || DEPLOYED_ESCROW_ASSETS.includes(wanted)) return wanted;
  return DEPLOYED_ESCROW_ASSETS[0];
})();

/**
 * Activos con los que se puede OPERAR hoy: los que tienen un escrow desplegado.
 *
 * No confundir con `isSupportedAsset`. Aquel dice que la aritmetica sabe
 * convertir el activo; este, que existe un contrato capaz de bloquearlo (las
 * claves de `ESCROW_CONTRACTS`). Si se aceptara otro, la operacion se crearia
 * con montos correctos y no habria contrato donde bloquearla.
 */
export const ENABLED_ESCROW_ASSETS: readonly SupportedAsset[] =
  DEPLOYED_ESCROW_ASSETS.length > 0 ? DEPLOYED_ESCROW_ASSETS : [DEFAULT_ASSET];

/** Longitud de `trades.asset_code` (VARCHAR(12)). */
export const ASSET_CODE_MAX_LENGTH = 12;

/** El activo tiene forma valida pero no hay escrow para operarlo (422). */
export class AssetNotEnabledError extends AppError {
  constructor(public readonly assetCode: string) {
    super(
      'ASSET_NOT_ENABLED',
      'Ese activo todavia no esta disponible para operar.',
      `Escrow asset not enabled: ${assetCode}. Enabled: ${ENABLED_ESCROW_ASSETS.join(', ')}`,
      422,
    );
  }
}

/**
 * Comprobacion estricta de un codigo YA normalizado: sin trim, sin mayusculas
 * y sin default. Es la politica comun a la creacion y al bloqueo; cada llamador
 * decide que error le corresponde al usuario (ver `assertLockableEscrowAsset`
 * en trade.service).
 */
export function assertEnabledEscrowAsset(code: string): SupportedAsset {
  if (!(ENABLED_ESCROW_ASSETS as readonly string[]).includes(code)) {
    throw new AssetNotEnabledError(code);
  }
  return code as SupportedAsset;
}

/**
 * El activo que PIDE quien crea una operacion.
 *
 * - Ausente (`undefined`) -> `DEFAULT_ASSET`. Los APK ya instalados no lo
 *   envian y deben seguir funcionando.
 * - Cualquier otro tipo, cadena vacia o mas larga que la columna -> 400.
 * - Cadena con forma valida -> trim + mayusculas, y 422 si no esta habilitado.
 *
 * El default se aplica SOLO aqui, a una peticion. Un registro ya guardado sin
 * activo es un dato incompleto, no un XLM implicito.
 */
export function resolveRequestedEscrowAsset(raw: unknown): SupportedAsset {
  if (raw === undefined) return DEFAULT_ASSET;
  return assertEnabledEscrowAsset(normalizeEscrowAssetCode(raw));
}

/**
 * Solo la FORMA (tipo y longitud) y la normalizacion, sin politica. Lanza 400;
 * si el activo esta habilitado lo decide `assertEnabledEscrowAsset`, con 422.
 * Asi `"USDC"` y `123` no acaban en el mismo codigo de error.
 *
 * La ruta la llama sobre el cuerpo CRUDO, antes de que ajv (con `coerceTypes`)
 * convierta 123 en "123" o null en "".
 */
export function normalizeEscrowAssetCode(raw: unknown): string {
  const invalid = (detail: string) =>
    new ValidationError('INVALID_ASSET_CODE', 'Por favor, verifica los datos ingresados.', detail);
  if (typeof raw !== 'string') {
    throw invalid(`asset_code must be a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  // La longitud se mide sobre la entrada CRUDA, igual que el `maxLength` del
  // schema. Medirla tras el trim dejaba pasar "          XLM" (13) por aqui,
  // y luego ajv la rechazaba con VALIDATION_ERROR en vez de INVALID_ASSET_CODE;
  // y una llamada directa al servicio la aceptaba (H6 de la auditoria).
  if (raw.length > ASSET_CODE_MAX_LENGTH) {
    throw invalid(`asset_code must have at most ${ASSET_CODE_MAX_LENGTH} characters`);
  }
  const code = raw.trim().toUpperCase();
  if (code.length === 0) {
    throw invalid('asset_code must not be blank');
  }
  return code;
}

/**
 * Convierte una tasa decimal ("3.126827") a entero escalado, sin pasar por
 * float. `parseFloat` sobre una tasa de 7 decimales ya introduce error, y ese
 * error acaba multiplicado por el monto.
 */
export function rateToScaled(rateMxn: string): bigint {
  const [whole, frac = ''] = String(rateMxn).trim().split('.');
  const padded = (frac + '0'.repeat(7)).slice(0, 7);
  const scaled = BigInt(whole || '0') * SCALE + BigInt(padded || '0');
  if (scaled <= 0n) {
    throw new BadRequestError(`Invalid exchange rate: ${rateMxn}`);
  }
  return scaled;
}

/**
 * Pesos -> stroops del activo, con redondeo half-up.
 *
 *     stroops = round(amountMxn * 10^7 / rateMxn)
 *
 * Con MXNE (tasa 1) devuelve exactamente `amountMxn * 10^7`, que es el
 * comportamiento historico: los montos de una operacion en pesos digitales no
 * cambian ni un stroop respecto a antes de este cambio.
 */
export function mxnToStroops(amountMxn: number, rateScaled: bigint): bigint {
  if (!Number.isInteger(amountMxn) || amountMxn < 0) {
    throw new BadRequestError(`Invalid MXN amount: ${amountMxn}`);
  }
  const numerator = BigInt(amountMxn) * SCALE * SCALE;
  // half-up: sumar la mitad del divisor antes de la division entera.
  return (numerator + rateScaled / 2n) / rateScaled;
}

/**
 * Resuelve la tasa viva del activo y convierte. La tasa devuelta se persiste en
 * la operacion: a partir de ese momento el acuerdo queda congelado y no lo
 * mueve una fluctuacion del mercado.
 */
export async function convertMxnToAsset(
  amountMxn: number,
  assetCode: string,
  request: FastifyRequest,
): Promise<AssetConversion> {
  const code = assetCode.toUpperCase();
  if (!isSupportedAsset(code)) {
    throw new BadRequestError(
      `Unsupported escrow asset: ${assetCode}. Supported: ${Object.keys(ASSETS).join(', ')}`,
    );
  }

  const spec = ASSETS[code];

  if (spec.fixedRate) {
    const rateScaled = rateToScaled(spec.fixedRate);
    return {
      stroops: mxnToStroops(amountMxn, rateScaled),
      rateMxn: spec.fixedRate,
      rateSource: 'fixed',
      assetCode: code,
    };
  }

  const { rate, source } = await getRateMxn(spec.pair!, request);
  const rateScaled = rateToScaled(rate);

  return {
    stroops: mxnToStroops(amountMxn, rateScaled),
    rateMxn: rate,
    rateSource: source,
    assetCode: code,
  };
}

/**
 * Reconstruye la conversion de una operacion YA CREADA usando su tasa
 * congelada. Es lo que deben usar el bloqueo y la verificacion del XDR: volver
 * a consultar la tasa viva ahi cambiaria el monto pactado por detras.
 */
export function stroopsAtFrozenRate(amountMxn: number, rateMxn: string): bigint {
  return mxnToStroops(amountMxn, rateToScaled(rateMxn));
}
