import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, Link } from 'react-router-dom';

import {
  fetchTradeDetail,
  completeTrade,
  cancelTradeRequest,
  refundTradeRequest,
  fetchRefundEligibility,
  type RefundEligibility,
  lockTrade,
  TradeDetailResponse,
} from '../services/api';
import TradeEscrowSummary from '../components/TradeEscrowSummary';
import { shouldKeepPollingTrade } from '../utils/escrowAmounts';
import { assertNoClientPreparationForLock } from '../utils/escrowLock';
import { errorMessages } from '../constants/errorMessages';
import { readJSON } from '../services/secureStorage';
import { useCountdown } from '../hooks/useCountdown';
import { buildTxUrl } from '../utils/stellarExplorer';
import { mapApiError } from '../utils/apiError';
import { parseTradeState, type TradeState } from '../components/TradeStateBadge';
import { resolveTradeActor, type TradeActor } from '../utils/tradeActor';
import { canConfirmCashReceived, confirmCashReceived, cashConfirmErrorMessage } from '../utils/cashConfirm';

type TradeDetailData = TradeDetailResponse['trade'] & {
  platform_fee_mxn?: number;
  release_tx_hash?: string | null;
  completed_at?: string | null;
};

interface TradeDetailProps {
  /**
   * CASH-7: un solo token de la sesion autenticada. Antes llegaban
   * `buyerToken` y `sellerToken`, siempre el mismo valor, y cada handler
   * hacia `buyerToken ?? sellerToken`. El rol en la operacion se deriva del
   * trade cargado, no del nombre del prop.
   */
  token: string | null;
  /**
   * CASH-5B: id de la sesion autenticada. Hace falta para derivar el papel en
   * ESTA operacion; no es un rol global (CASH-7).
   */
  userId: string | null;
  onBack: () => void;
}

async function getStoredUser(): Promise<{ id: string; token: string } | null> {
  try {
    return await readJSON<{ id: string; token: string }>('micopay_user');
  } catch {
    return null;
  }
}

async function getStoredToken(): Promise<string | null> {
  const stored = await getStoredUser();
  return stored?.token ?? null;
}

async function isCurrentUserBuyer(tradeBuyerId: string): Promise<boolean> {
  const stored = await getStoredUser();
  return stored?.id === tradeBuyerId;
}

async function isCurrentUserSeller(tradeSellerId: string): Promise<boolean> {
  const stored = await getStoredUser();
  return stored?.id === tradeSellerId;
}

const TRADE_POLL_INTERVAL = 5000;
const SUPPORT_EMAIL = 'support@micopay.io';

/**
 * CASH-5A: la píldora compacta del detalle. La presentación puede diferir de
 * la tarjeta de `TradeStateBadge`, pero el CONJUNTO de estados no: este
 * `Record<TradeState, ...>` obliga a cubrir todos los canónicos y solo esos.
 * Antes incluía `revealed`, que ningún backend emite.
 */
const STATUS_CONFIG: Record<TradeState, { label: string; color: string; icon: string }> = {
  pending: { label: 'Pendiente', color: '#f59e0b', icon: 'hourglass_top' },
  locked: { label: 'Bloqueado', color: '#3b82f6', icon: 'lock' },
  revealing: { label: 'Revelando', color: '#8b5cf6', icon: 'qr_code' },
  completed: { label: 'Completado', color: '#22c55e', icon: 'check_circle' },
  cancelled: { label: 'Cancelado', color: '#ef4444', icon: 'cancel' },
  expired: { label: 'Expirado', color: '#6b7280', icon: 'schedule' },
  refunded: { label: 'Reembolsado', color: '#8b5cf6', icon: 'undo' },
};

const UNKNOWN_STATUS_CONFIG = { label: 'Estado desconocido', color: '#6b7280', icon: 'help' };

function TradeStatusPill({ status }: { status: string }) {
  // CASH-5A: antes hacía `STATUS_CONFIG[status] || STATUS_CONFIG.pending`, así
  // que un estado fuera del contrato se rotulaba "Pendiente" — un estado que
  // sí habilita acciones. Ahora se dice que no se reconoce.
  const canonical = parseTradeState(status);
  const config = canonical ? STATUS_CONFIG[canonical] : UNKNOWN_STATUS_CONFIG;

  return (
    <div
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full"
      style={{
        background: `${config.color}20`,
        border: `1px solid ${config.color}40`,
      }}
    >
      <span className="material-symbols-outlined text-sm" style={{ color: config.color, fontVariationSettings: '"FILL" 1' }}>
        {config.icon}
      </span>
      <span className="text-sm font-semibold" style={{ color: config.color }}>
        {config.label}
      </span>
    </div>
  );
}

function SupportLink() {
  return (
    <div className="mt-8 text-center">
      <p className="text-sm text-on-surface-variant">
        ¿Necesitas ayuda?{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary font-semibold hover:underline">
          Contactar soporte
        </a>
      </p>
    </div>
  );
}

// ── State-specific views ────────────────────────────────────────────────────

function PendingView({
  trade,
  onCancel,
  isSeller,
  onLock,
  locking,
  lockError,
}: {
  trade: TradeDetailData;
  onCancel: () => void;
  isSeller: boolean;
  onLock: () => void;
  locking: boolean;
  lockError: string | null;
}) {
  const { label: countdownLabel, expired: countdownExpired } = useCountdown(trade.expires_at ?? null);
  const countdown = countdownExpired ? 'Expirado' : countdownLabel;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-amber-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-amber-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          hourglass_top
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">
        {isSeller ? 'Bloquea los fondos para iniciar' : 'Esperando al vendedor'}
      </h2>
      <p className="text-on-surface-variant mb-6">
        {isSeller
          ? 'Firma con tu llave para bloquear los fondos en el contrato de garantía.'
          : 'El vendedor aún no ha bloqueado los fondos. Tu operación está segura en garantía.'}
      </p>

      <div className="bg-surface-container-low rounded-sm p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="num font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="num text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Expira en</span>
          <span className="text-sm font-semibold text-primary">{countdown}</span>
        </div>
      </div>

      {lockError && (
        <div className="mb-4 w-full rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {lockError}
        </div>
      )}

      {isSeller && (
        <button
          onClick={onLock}
          disabled={locking}
          className="w-full py-3 mb-4 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {locking ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Bloqueando…
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>lock</span>
              Bloquear fondos
            </>
          )}
        </button>
      )}

      <button
        onClick={onCancel}
        disabled={locking}
        className="w-full py-3 rounded-sm border border-error text-error font-semibold hover:bg-error/5 transition-colors disabled:opacity-50"
      >
        Cancelar operación
      </button>
    </div>
  );
}

interface CashConfirmProps {
  /** Si a quien mira le toca confirmar el efectivo (agente de un depósito). */
  canConfirm: boolean;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
}

function LockedView({ trade, cashConfirm }: { trade: TradeDetailData; cashConfirm?: CashConfirmProps }) {
  // Segundo paso antes de confirmar: al confirmar, el cliente puede liberar la
  // cripto del agente, así que un toque accidental le costaría sus fondos.
  const [askingCash, setAskingCash] = useState(false);

  if (cashConfirm?.canConfirm) {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-sm bg-blue-100 flex items-center justify-center mb-6">
          <span className="material-symbols-outlined text-blue-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
            lock
          </span>
        </div>
        <h2 className="text-2xl font-bold text-on-surface mb-2">Tus fondos están en garantía</h2>
        <p className="text-on-surface-variant mb-6">
          Cuando el cliente te entregue el efectivo, escanea su código desde tu bandeja o confírmalo aquí.
        </p>

        {trade.lock_tx_hash && (
          <a
            href={buildTxUrl(trade.lock_tx_hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
          >
            Ver transacción en Stellar
            <span className="material-symbols-outlined text-sm">open_in_new</span>
          </a>
        )}

        {cashConfirm.error && (
          <p role="alert" className="w-full mb-4 p-3 bg-red-50 border border-red-200 rounded-sm text-red-700 text-sm font-medium">
            {cashConfirm.error}
          </p>
        )}

        {!askingCash ? (
          <button
            onClick={() => setAskingCash(true)}
            disabled={cashConfirm.confirming}
            className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Recibí el efectivo
          </button>
        ) : (
          <div className="w-full border-2 border-tinta rounded-sm p-4 text-left">
            <p className="font-bold text-on-surface mb-1">¿Ya tienes el efectivo en la mano?</p>
            <p className="text-sm text-on-surface-variant mb-4">
              Al confirmar, el cliente podrá recibir los activos que bloqueaste. No se puede deshacer.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setAskingCash(false)}
                disabled={cashConfirm.confirming}
                className="flex-1 py-3 rounded-sm border-2 border-tinta font-semibold disabled:opacity-40"
              >
                Todavía no
              </button>
              <button
                onClick={cashConfirm.onConfirm}
                disabled={cashConfirm.confirming}
                className="flex-1 py-3 rounded-sm bg-primary text-papel font-semibold disabled:opacity-40"
              >
                {cashConfirm.confirming ? 'Confirmando…' : 'Sí, lo recibí'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-blue-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-blue-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          lock
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Fondos bloqueados</h2>
      <p className="text-on-surface-variant mb-6">
        Los fondos están seguros en el contrato inteligente. Esperando confirmación del vendedor.
      </p>

      {trade.lock_tx_hash && (
        <a
          href={buildTxUrl(trade.lock_tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <button className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity">
        Abrir chat con el vendedor
      </button>
    </div>
  );
}

/**
 * CASH-5B · `revealing` para las cuatro combinaciones de flujo y actor.
 *
 * Antes esta vista tenia dos botones sin onClick y un texto unico ("El
 * vendedor confirmo el pago") que no era cierto para nadie: en cash-out quien
 * espera es el cliente, y en deposito es el proveedor. Toda la logica de
 * liberar vivia en una vista atada a `revealed`, un estado que ningun backend
 * emite, asi que en produccion nadie podia completar desde esta pantalla.
 *
 * La regla: **libera siempre el comprador del escrow**, porque el contrato
 * exige su firma y la cripto se le entrega a el. Eso es el proveedor en
 * cash-out y el cliente en deposito.
 */
function RevealingView({
  trade,
  actor,
  onComplete,
  token,
  onShowQR,
  onOpenChat,
  onGoToScanner,
}: {
  trade: TradeDetailData;
  actor: TradeActor;
  onComplete: () => void;
  token: string | null;
  onShowQR: () => void;
  onOpenChat: () => void;
  onGoToScanner: () => void;
}) {
  // Quien libera: proveedor en cash-out, cliente en deposito.
  if (actor.canRelease) {
    // En cash-out el proveedor NO puede liberar sin haber escaneado el codigo
    // del cliente: CASH-4 exige la constancia durable de la entrega. Mandarlo
    // al escaner es la accion honesta; ofrecerle "liberar" aqui produciria un
    // 409 CASH_HANDOFF_REQUIRED.
    if (actor.flow === 'cashout') {
      return (
        <ActionView
          icon="qr_code_scanner"
          tone="bg-naranja-suave"
          iconTone="text-naranja"
          title="Escanea el código del cliente"
          body="Entrega el efectivo y escanea el código que te muestra. Los fondos se liberan a tu cuenta al confirmar la entrega."
          primary={{ label: 'Ir a escanear', onClick: onGoToScanner }}
          secondary={{ label: 'Abrir chat', onClick: onOpenChat }}
        />
      );
    }
    // Deposito: el cliente entrega efectivo y libera para recibir la cripto.
    return (
      <ConfirmReleaseView trade={trade} onComplete={onComplete} token={token} onOpenChat={onOpenChat} />
    );
  }

  // Quien espera. El texto dice quien tiene la siguiente accion, no una
  // generalidad.
  if (actor.flow === 'cashout') {
    return (
      <ActionView
        icon="qr_code_2"
        tone="bg-verde-suave"
        iconTone="text-verde"
        title="Muestra tu código"
        body="Tu cripto está en garantía. Muestra el código al agente; cuando te entregue el efectivo y lo escanee, la operación se cierra."
        primary={{ label: 'Ver mi código', onClick: onShowQR }}
        secondary={{ label: 'Abrir chat', onClick: onOpenChat }}
      />
    );
  }

  return (
    <ActionView
      icon="hourglass_top"
      tone="bg-fondo"
      iconTone="text-gris"
      title="Esperando al cliente"
      body="Tu cripto está en garantía. El cliente confirmará cuando te haya entregado el efectivo; entonces los fondos pasan a su cuenta."
      secondary={{ label: 'Abrir chat', onClick: onOpenChat }}
    />
  );
}

/** Presentación común de las vistas de `revealing`. */
function ActionView({
  icon,
  tone,
  iconTone,
  title,
  body,
  primary,
  secondary,
}: {
  icon: string;
  tone: string;
  iconTone: string;
  title: string;
  body: string;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className={`w-16 h-16 rounded-sm ${tone} border-2 border-tinta flex items-center justify-center mb-6`}>
        <span aria-hidden="true" className={`material-symbols-outlined ${iconTone} text-3xl`} style={{ fontVariationSettings: '"FILL" 1' }}>
          {icon}
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{title}</h2>
      <p className="text-on-surface-variant mb-6">{body}</p>

      {primary && (
        <button
          onClick={primary.onClick}
          className="w-full min-h-12 py-3 rounded-sm bg-naranja text-papel border-2 border-tinta shadow-solida font-bold transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs mb-4"
        >
          {primary.label}
        </button>
      )}
      {secondary && (
        <button
          onClick={secondary.onClick}
          className="w-full min-h-12 py-3 rounded-sm border-2 border-tinta text-tinta font-bold hover:bg-surface-container-low transition-colors"
        >
          {secondary.label}
        </button>
      )}
    </div>
  );
}


/**
 * CASH-5B: era `RevealedView`, atada al estado inventado `revealed` que
 * CASH-5A elimino, asi que en produccion era inalcanzable: el guard contra
 * declarar liberados unos fondos que siguen en garantia estaba escrito y
 * nadie podia llegar a el. Ahora la usa el comprador del escrow en deposito.
 */
function ConfirmReleaseView({ trade, onComplete, token, onOpenChat }: { trade: TradeDetailData; onComplete: () => void; token: string | null; onOpenChat: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // La pantalla sólo avanza a "completado" si el release confirmó de verdad.
  // Antes el catch sólo logueaba y el finally transicionaba igual, así que un
  // release fallido —o la falta de token— se mostraba como éxito
  // (docs/AUDIT_MOBILE_MAINNET.md §4, "honestidad sobre fondos").
  const handleConfirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    setConfirmError(null);
    try {
      const effectiveToken = token ?? (await getStoredToken());
      if (!effectiveToken) throw new Error('NO_TOKEN');
      await completeTrade(trade.id, effectiveToken);
      setTimeout(() => onComplete(), 1500);
    } catch (e) {
      setIsConfirming(false);
      // El motivo lo traduce mapApiError (el mapeo de errores del repo); lo
      // único que se añade es dónde quedó el dinero, que UX_MANIFESTO exige
      // decir en todo estado de error.
      const reason = e instanceof Error && e.message === 'NO_TOKEN'
        ? 'Tu sesión expiró. Vuelve a entrar para confirmar.'
        : mapApiError(e).message;
      setConfirmError(`${reason} El dinero sigue retenido en la garantía.`);
    }
  };

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-cyan-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-cyan-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          visibility
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Confirmar la entrega</h2>
      <p className="text-on-surface-variant mb-6">
        {/* CASH-5B: el texto anterior decia "confirma para liberar los fondos
            al vendedor", y es al reves: liberar entrega la cripto a quien
            confirma, porque el contrato exige la firma del comprador. */}
        ¿Ya entregaste el efectivo al agente? Al confirmar, la cripto en garantía
        pasa a tu cuenta.
      </p>

      {confirmError && (
        <div className="w-full mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-left">
          <p className="text-sm font-semibold text-red-800">No se pudo confirmar</p>
          <p className="mt-1 text-sm text-red-700">{confirmError}</p>
        </div>
      )}

      {!isConfirming ? (
        <button
          onClick={handleConfirm}
          className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>
            {confirmError ? 'refresh' : 'check_circle'}
          </span>
          {confirmError ? 'Reintentar' : 'Ya entregué el efectivo'}
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="relative w-8 h-8">
            <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
            <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
          <p className="text-sm font-medium text-gris">Confirmando intercambio…</p>
        </div>
      )}

      {/* CASH-5B: el chat es la unica accion segura en cualquier momento, y
          las cuatro vistas de `revealing` la ofrecen. */}
      <button
        onClick={onOpenChat}
        className="mt-4 w-full min-h-12 py-3 rounded-sm border-2 border-tinta text-tinta font-bold hover:bg-surface-container-low transition-colors"
      >
        Abrir chat
      </button>
    </div>
  );
}

function CompletedView({ trade }: { trade: TradeDetailData }) {

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-green-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-green-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          check_circle
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">¡Operación completada!</h2>
      <p className="text-on-surface-variant mb-6">Tu intercambio fue exitoso.</p>

      <div className="bg-surface-container-low rounded-sm p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="num font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Fecha</span>
          <span className="text-sm text-on-surface">
            {trade.completed_at ? new Date(trade.completed_at).toLocaleString('es-MX') : '-'}
          </span>
        </div>
      </div>

      {trade.release_tx_hash && (
        <a
          href={buildTxUrl(trade.release_tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <Link
        to="/"
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

function CancelledView() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          cancel
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Operación cancelada</h2>
      <p className="text-on-surface-variant mb-6">
        Esta operación fue cancelada. Tus fondos están seguros.
      </p>

      <Link
        to="/"
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

/**
 * Shown both for the (currently unreachable — the backend never persists
 * status='expired') 'expired' state and for a 'cancelled' trade that still
 * has real on-chain funds pending refund (lock_tx_hash set, release_tx_hash
 * unset). See docs/AUDIT_MOBILE_MAINNET.md finding B3.
 */
function ExpiredView({ canRefund, onRefund, refunding, trade, title, description }: {
  canRefund: boolean;
  onRefund: () => void;
  refunding: boolean;
  trade: TradeDetailData;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-gray-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-gray-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          schedule
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{title}</h2>
      <p className="text-on-surface-variant mb-6">{description}</p>

      <div className="bg-surface-container-low rounded-sm p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="num font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="num text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
      </div>

      {/* Either participant may trigger the refund — the contract always pays
          out to the seller (whoever locked funds) regardless of who calls it. */}
      {canRefund ? (
        <button
          onClick={onRefund}
          disabled={refunding}
          className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {refunding ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Procesando reembolso…
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>undo</span>
              Recuperar fondos
            </>
          )}
        </button>
      ) : (
        <Link
          to="/"
          className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
        >
          Volver al inicio
        </Link>
      )}
    </div>
  );
}

function RefundedView({ trade }: { trade: TradeDetailData }) {
  const refundTxHash = trade.release_tx_hash;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-purple-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-purple-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          undo
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Fondos reembolsados</h2>
      <p className="text-on-surface-variant mb-6">
        Los fondos fueron devueltos exitosamente. El tiempo para completar la operación había expirado.
      </p>

      <div className="bg-surface-container-low rounded-sm p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="num font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="num text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
      </div>

      {refundTxHash && (
        <a
          href={buildTxUrl(refundTxHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción de reembolso en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <Link
        to="/"
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

// ── Error views ─────────────────────────────────────────────────────────────

function NotFoundError() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          search_off
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.generic.fallback.title}</h2>
      <p className="text-on-surface-variant mb-2">La operación que buscas no existe o fue eliminada.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.generic.fallback.action}</p>

      <Link
        to="/"
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>

      <SupportLink />
    </div>
  );
}

function ForbiddenError() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          lock_person
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.auth.unauthorized.title}</h2>
      <p className="text-on-surface-variant mb-2">No tienes permiso para ver esta operación. Solo los participantes pueden acceder.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.auth.unauthorized.action}</p>

      <Link
        to="/"
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>

      <SupportLink />
    </div>
  );
}

function NetworkError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-sm bg-orange-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-orange-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          wifi_off
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.network.offline.title}</h2>
      <p className="text-on-surface-variant mb-2">No se pudo conectar al servidor. Verifica tu conexión e intenta de nuevo.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.network.offline.action}</p>

      <button
        onClick={onRetry}
        className="w-full py-3 rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity mb-4"
      >
        Reintentar
      </button>

      <SupportLink />
    </div>
  );
}

// ── Refund confirmation dialog ─────────────────────────────────────────────

function RefundConfirmDialog({
  open,
  amount,
  fee,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  open: boolean;
  amount: number;
  fee: number;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
  error: string | null;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-title"
    >
      <div className="w-full max-w-md rounded-sm bg-surface p-6 border-2 border-tinta">
        <h2 id="refund-title" className="font-headline text-lg font-bold text-on-surface">
          Recuperar fondos
        </h2>
        <p className="mt-3 text-sm text-on-surface-variant leading-relaxed">
          El intercambio expiró. Al recuperar los fondos se ejecutará el reembolso en la
          blockchain de Stellar. Esta operación tiene un costo de gas fee en XLM.
        </p>

        <div className="mt-4 bg-surface-container-low rounded-sm p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-on-surface-variant">Monto a recuperar</span>
            <span className="num font-bold text-on-surface">${amount} MXN</span>
          </div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-on-surface-variant">Comisión de la operación</span>
            <span className="num text-sm text-on-surface">${fee} MXN</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-linea">
            <span className="text-sm font-semibold text-on-surface-variant">Total devuelto</span>
            <span className="num font-bold text-primary">${amount} MXN</span>
          </div>
          <p className="mt-3 text-xs text-on-surface-variant">
            * Se aplicará un gas fee en XLM por la transacción en Stellar. Los fondos en MXN
            serán devueltos a tu cuenta.
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            <p>{error}</p>
            <p className="mt-2 text-xs">
              <a href="mailto:soporte@micopay.app" className="font-semibold underline">
                Contactar soporte
              </a>
            </p>
          </div>
        )}

        <div className="mt-6 flex gap-2 justify-end">
          <button
            type="button"
            className="rounded-sm px-4 py-2 text-sm font-semibold text-primary hover:bg-surface-container-low"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-papel disabled:opacity-50"
            onClick={onConfirm}
          >
            {submitting ? 'Procesando…' : 'Sí, recuperar fondos'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

function TradeDetailContent({ token, userId, onBack }: TradeDetailProps) {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trade, setTrade] = useState<TradeDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not_found' | 'forbidden' | 'network' | null>(null);
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const [isRefunding, setIsRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [isBuyer, setIsBuyer] = useState(false);
  const [isSeller, setIsSeller] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [isConfirmingCash, setIsConfirmingCash] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  // CASH-6: la elegibilidad la decide el servidor. La UI ofrecia el reembolso
  // solo con estado `expired`, que nunca se persiste, asi que una operacion
  // `locked` o `revealing` vencida quedaba sin salida visible.
  const [refundEligibility, setRefundEligibility] = useState<RefundEligibility | null>(null);

  // Se consulta al cargar y tras cada cambio de estado, para que el CTA
  // aparezca en cuanto venza sin depender del reloj del dispositivo.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!trade?.id) return;
      const effectiveToken = token ?? (await getStoredToken());
      if (!effectiveToken) return;
      try {
        const eligibility = await fetchRefundEligibility(trade.id, effectiveToken);
        if (!cancelled) setRefundEligibility(eligibility);
      } catch {
        // Sin elegibilidad no se inventa un CTA: se deja como estaba.
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [trade?.id, trade?.status, token]);

  useEffect(() => {
    if (trade?.buyer_id) {
      isCurrentUserBuyer(trade.buyer_id).then(setIsBuyer);
    }
    if (trade?.seller_id) {
      isCurrentUserSeller(trade.seller_id).then(setIsSeller);
    }
  }, [trade?.buyer_id, trade?.seller_id]);

  const fetchTrade = useCallback(async () => {
    if (!id) return;

    const effectiveToken = token ?? (await getStoredToken());
    if (!effectiveToken) {
      navigate('/');
      return;
    }

    try {
      const data = await fetchTradeDetail(id, effectiveToken);
      setTrade(data.trade as TradeDetailData);
      setError(null);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) {
        setError('not_found');
      } else if (status === 403) {
        setError('forbidden');
      } else {
        setError('network');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate, token]);

  // Fetch on mount
  useEffect(() => {
    fetchTrade();
  }, [fetchTrade]);

  // Poll mientras la operacion siga viva o tenga fondos sin liquidar (H2):
  // una cancelada con bloqueo espera el reembolso, y la pantalla tiene que
  // enterarse cuando llegue.
  const keepPolling = shouldKeepPollingTrade(trade);
  useEffect(() => {
    if (!keepPolling) return;

    const interval = setInterval(fetchTrade, TRADE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [keepPolling, fetchTrade]);

  // Handle cancel
  const handleCancel = async () => {
    if (!trade) return;

    const effectiveToken = token ?? (await getStoredToken());
    if (!effectiveToken) return;

    try {
      await cancelTradeRequest(trade.id, effectiveToken);
      fetchTrade(); // Refresh trade state
    } catch (e) {
      console.error('Failed to cancel trade', e);
    }
  };

  // Handle complete (navigate to success)
  const handleComplete = () => {
    fetchTrade(); // Refresh to get completed state
  };

  // Handle lock (seller signs lock() with their own device key)
  const handleLock = async () => {
    if (!trade || isLocking) return;
    const effectiveToken = token ?? (await getStoredToken());
    if (!effectiveToken) return;

    setIsLocking(true);
    setLockError(null);
    try {
      // H3: el activo sale de la OPERACION, no de la configuracion del APK, y
      // el cliente no envia ningun ChangeTrust previo (XLM no lo necesita).
      assertNoClientPreparationForLock(trade.asset_code);
      await lockTrade(trade.id, effectiveToken);
      fetchTrade(); // Refresh to get locked state
    } catch (e: any) {
      setLockError(e?.response?.data?.message || e?.message || 'No se pudo bloquear los fondos. Intenta de nuevo.');
    } finally {
      setIsLocking(false);
    }
  };

  // Depósito: el agente confirma que recibió el efectivo (`reveal`).
  const handleConfirmCash = async () => {
    if (!trade || isConfirmingCash) return;
    const effectiveToken = token ?? (await getStoredToken());
    if (!effectiveToken) {
      setCashError('Tu sesión expiró. Vuelve a entrar para confirmar el efectivo.');
      return;
    }
    setIsConfirmingCash(true);
    setCashError(null);
    try {
      await confirmCashReceived(trade.id, effectiveToken);
      fetchTrade();
    } catch (e) {
      setCashError(cashConfirmErrorMessage(e));
    } finally {
      setIsConfirmingCash(false);
    }
  };

  // Handle refund
  const handleRefundConfirm = async () => {
    if (!trade) return;
    // CASH-6: guarda contra doble envio. Sin esto, dos toques seguidos
    // mandaban dos reembolsos; el segundo choca contra el guard de replay del
    // backend, pero el usuario veia un error donde en realidad todo salio bien.
    if (isRefunding) return;

    // El respaldo de sesion se calculaba y luego no se usaba: se comprobaba y
    // se enviaba `token`, asi que con la sesion en memoria vacia el reembolso
    // se abandonaba en silencio aunque hubiera token guardado.
    const effectiveToken = token ?? (await getStoredToken());
    if (!effectiveToken) {
      setRefundError('Tu sesión expiró. Vuelve a entrar para recuperar tus fondos.');
      return;
    }

    setIsRefunding(true);
    setRefundError(null);
    try {
      await refundTradeRequest(trade.id, effectiveToken);
      setShowRefundConfirm(false);
      fetchTrade();
    } catch (e: any) {
      setRefundError(e.message || 'Error al procesar el reembolso. Intenta de nuevo.');
    } finally {
      setIsRefunding(false);
    }
  };

  const handleRefundClick = () => {
    setRefundError(null);
    setShowRefundConfirm(true);
  };

  const handleCloseRefundConfirm = () => {
    if (!isRefunding) {
      setShowRefundConfirm(false);
      setRefundError(null);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-surface-container-high border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-on-surface-variant text-sm">Cargando operación…</p>
        </div>
      </div>
    );
  }

  // Error states
  if (error === 'not_found') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <NotFoundError />
      </div>
    );
  }

  if (error === 'forbidden') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <ForbiddenError />
      </div>
    );
  }

  if (error === 'network') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <NetworkError onRetry={fetchTrade} />
      </div>
    );
  }

  if (!trade) {
    return null;
  }

  // Render state-specific view
  // CASH-5B: el papel se deriva de ESTA operación, no de la sesión.
  const actor = resolveTradeActor(userId, trade);

  const renderStateView = () => {
    switch (trade.status) {
      case 'pending':
        return (
          <PendingView
            trade={trade}
            onCancel={handleCancel}
            isSeller={isSeller}
            onLock={handleLock}
            locking={isLocking}
            lockError={lockError}
          />
        );
      case 'locked':
        // CASH-6: si el servidor dice que ya vencio con fondos bloqueados, la
        // recuperacion se ofrece aqui mismo. Antes habia que esperar a un
        // estado `expired` que nunca llega a persistirse.
        if (refundEligibility?.eligible) {
          return (
            <ExpiredView
              canRefund
              onRefund={handleRefundClick}
              refunding={isRefunding}
              trade={trade}
              title="Se agotó el tiempo"
              description="Nadie completó la entrega a tiempo. Tus fondos siguen en el contrato y puedes recuperarlos ahora."
            />
          );
        }
        return (
          <LockedView
            trade={trade}
            cashConfirm={{
              canConfirm: canConfirmCashReceived(actor, trade.status),
              confirming: isConfirmingCash,
              error: cashError,
              onConfirm: handleConfirmCash,
            }}
          />
        );
      case 'revealing':
        // CASH-6: igual que en `locked` — vencida con fondos dentro, la salida
        // es el reembolso y no la accion del flujo, que ya no puede completarse.
        if (refundEligibility?.eligible) {
          return (
            <ExpiredView
              canRefund
              onRefund={handleRefundClick}
              refunding={isRefunding}
              trade={trade}
              title="Se agotó el tiempo"
              description="Nadie completó la entrega a tiempo. Tus fondos siguen en el contrato y puedes recuperarlos ahora."
            />
          );
        }
        // CASH-5A eliminó `case 'revealed'`, un estado que ningún backend
        // emite. CASH-5B trae aquí la acción real, repartida por flujo y
        // actor: la vista de confirmación ya no queda inalcanzable.
        return (
          <RevealingView
            trade={trade}
            actor={actor}
            onComplete={handleComplete}
            token={token}
            onShowQR={() => navigate('/qr-reveal')}
            onOpenChat={() => navigate('/chat')}
            onGoToScanner={() => navigate('/inbox')}
          />
        );
      case 'completed':
        return <CompletedView trade={trade} />;
      case 'cancelled':
        // A cancelled trade can still have real funds sitting in escrow —
        // cancelling only stops the app-level flow, it doesn't itself settle
        // on-chain (see docs/AUDIT_MOBILE_MAINNET.md finding B3). A backend
        // sweep auto-refunds these once the contract timeout passes, but we
        // also surface a manual "Recuperar fondos" retry here so the user
        // isn't just waiting on a background job with no visible feedback.
        if (trade.lock_tx_hash && !trade.release_tx_hash) {
          return (
            <ExpiredView
              canRefund={isBuyer || isSeller}
              onRefund={handleRefundClick}
              refunding={isRefunding}
              trade={trade}
              title="Reembolso pendiente"
              description="Esta operación fue cancelada. Tus fondos siguen en el contrato y se liberan automáticamente — también puedes recuperarlos ahora."
            />
          );
        }
        return <CancelledView />;
      case 'expired':
        return (
          <ExpiredView
            canRefund={isBuyer || isSeller}
            onRefund={handleRefundClick}
            refunding={isRefunding}
            trade={trade}
            title="Operación expirada"
            description="El tiempo para completar esta operación ha expirado."
          />
        );
      case 'refunded':
        return <RefundedView trade={trade} />;
      default:
        return (
          <PendingView
            trade={trade}
            onCancel={handleCancel}
            isSeller={isSeller}
            onLock={handleLock}
            locking={isLocking}
            lockError={lockError}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-surface-container-lowest font-body text-on-surface">
      {/* TopAppBar */}
      <header className="sticky top-0 z-50 bg-surface-container-lowest/80 border-b-2 border-tinta pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button aria-label={t('a11y.back')}
              onClick={onBack}
              className="min-h-12 min-w-12 min-h-12 min-w-12 flex items-center justify-center rounded-sm transition-colors text-primary"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div>
              <h1 className="font-headline font-bold text-lg text-on-surface">Detalle de operación</h1>
              <p className="text-xs text-on-surface-variant font-mono truncate max-w-[200px]">
                ID: {trade.id.substring(0, 12)}…
              </p>
            </div>
          </div>
          <TradeStatusPill status={trade.status} />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-6 py-8">
        {/* WP-D: la cifra del escrow que le toca a quien mira, con datos del
            servidor. Sin metadatos de activo no se pinta. */}
        <TradeEscrowSummary trade={trade} viewerId={userId} className="mb-4" />
        {renderStateView()}

        {/* Support link visible in all states */}
        {trade.status !== 'completed' && trade.status !== 'cancelled' && trade.status !== 'expired' && trade.status !== 'refunded' && (
          <SupportLink />
        )}
      </main>

      {/* CASH-6: el diálogo estaba condicionado a `status === 'expired'`, un
          estado que —como admitía el propio comentario anterior— el backend
          nunca persiste. Resultado: aunque el botón se mostrara, pulsarlo no
          abría nada. Ahora se rige por la elegibilidad que decide el servidor,
          más el caso de una operación cancelada con fondos aún dentro. */}
      {(refundEligibility?.eligible ||
        (trade.status === 'cancelled' && trade.lock_tx_hash && !trade.release_tx_hash)) && (
        <RefundConfirmDialog
          open={showRefundConfirm}
          amount={trade.amount_mxn}
          fee={trade.platform_fee_mxn ?? 0}
          onClose={handleCloseRefundConfirm}
          onConfirm={handleRefundConfirm}
          submitting={isRefunding}
          error={refundError}
        />
      )}
    </div>
  );
}

export default function TradeDetail(props: TradeDetailProps) {
  return <TradeDetailContent {...props} />;
}
