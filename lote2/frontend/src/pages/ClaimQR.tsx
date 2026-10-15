import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import SupportLink from '../components/SupportLink';
import { resolveErrorMessage } from '../constants/errorMap';
import { Badge, Card, Label } from '../components/ui';

/* Pantalla de cobro por enlace externo (/claim/:requestId).
   La abre el COMERCIANTE desde un enlace, normalmente en WhatsApp, sin haber
   instalado la app. Es la superficie del producto que más se parece a la
   landing, y era la única escrita entera con estilos inline: no pasaba por
   Tailwind ni por los tokens, así que se quedó fuera de F0-F4.

   Solo cambia la presentación. El sondeo cada 4 s, el cálculo del tiempo
   restante y el payload del QR quedan intactos, igual que el copy. */

const PROTOCOL_API = (import.meta as any).env?.VITE_PROTOCOL_API_URL ?? 'http://localhost:3000';

interface CashRequest {
  request_id: string;
  status: 'pending' | 'accepted' | 'completed' | 'expired';
  merchant_name: string;
  amount_mxn: number;
  amount_usdc: string;
  htlc_tx_hash: string;
  expires_at: string;
}

interface ClaimQRProps {
  requestId: string;
}

function useCountdown(expiresAt: string | null) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) { setRemaining('Expirado'); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      setRemaining(h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return remaining;
}

/* Los emoji de estado se van: el sistema tiene iconos y el emoji se dibuja
   distinto en cada fabricante. El tono sigue la tabla de §4.4 del plan —
   `accepted` es naranja porque es cuando aparece el efectivo. */
type Tono = 'aviso' | 'naranja' | 'verde' | 'papel';
const STATUS_LABEL: Record<string, { text: string; tono: Tono; icon: string }> = {
  pending:   { text: 'Esperando al comerciante', tono: 'aviso',   icon: 'hourglass_top' },
  accepted:  { text: 'Comerciante listo',        tono: 'naranja', icon: 'payments' },
  completed: { text: '¡Efectivo entregado!',     tono: 'verde',   icon: 'check_circle' },
  expired:   { text: 'Solicitud expirada',       tono: 'papel',   icon: 'schedule' },
};

export default function ClaimQR({ requestId }: ClaimQRProps) {
  const [data, setData] = useState<CashRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(data?.expires_at ?? null);

  // Build the QR payload from the request data
  const qrPayload = data
    ? `micopay://claim?request_id=${data.request_id}&amount_mxn=${data.amount_mxn}&htlc=${data.htlc_tx_hash}`
    : '';

  // Poll status every 4 seconds
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${PROTOCOL_API}/api/v1/cash/request/${requestId}`);
        if (!res.ok) { setError(resolveErrorMessage({ response: { status: res.status } }).message); return; }
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(resolveErrorMessage({ message: 'backend_not_available' }).message);
      }
    };

    poll();
    const id = setInterval(() => {
      if (data?.status === 'completed' || data?.status === 'expired') return;
      poll();
    }, 4000);

    return () => { cancelled = true; clearInterval(id); };
  }, [requestId, data?.status]);

  const status = data ? (STATUS_LABEL[data.status] ?? STATUS_LABEL.pending) : null;

  // ── Cargando ─────────────────────────────────────────────────────────────
  if (!data && !error) {
    return (
      <div className="flex min-h-[100svh] items-center justify-center bg-fondo px-6">
        <p className="text-[15px] text-gris">Cargando solicitud…</p>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex min-h-[100svh] items-center justify-center bg-fondo px-6">
        <Card className="max-w-sm text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-[32px] text-rojo">error</span>
          <p className="mt-2 font-bold text-tinta">{error}</p>
          <p className="num mt-2 text-[13px] text-gris">ID: {requestId}</p>
          <div className="mt-4">
            <SupportLink state="ERROR" tradeId={requestId} />
          </div>
        </Card>
      </div>
    );
  }

  // ── Principal ────────────────────────────────────────────────────────────
  const done = data!.status === 'completed' || data!.status === 'expired';

  return (
    <div className="flex min-h-[100svh] flex-col items-center bg-fondo px-4 pb-10 pt-6">
      <div className="w-full max-w-[400px]">
        <header className="mb-5">
          <div className="mb-1 flex items-center gap-2.5">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="3" stroke="var(--color-tinta)" strokeWidth="2.5" />
              <circle cx="17" cy="17" r="3" stroke="var(--color-naranja)" strokeWidth="2.5" />
              <path d="M10 10L14 14" stroke="var(--color-tinta)" strokeLinecap="round" strokeWidth="2.5" />
            </svg>
            <span
              className="font-display text-[19px] font-extrabold uppercase tracking-[-.02em]"
              style={{ fontVariationSettings: '"wdth" 112' }}
              translate="no"
            >
              <span className="text-tinta">Mico</span>
              <span className="text-naranja">Pay</span>
            </span>
          </div>
          <p className="text-[13px] text-gris">Muestra este QR al comerciante para recibir tu efectivo</p>
        </header>

        <div className="mb-5">
          <Badge tono={status!.tono}>
            <span aria-hidden="true" className="material-symbols-outlined mr-1 text-[14px]">{status!.icon}</span>
            {status!.text}
          </Badge>
        </div>

        {/* El QR va sobre PAPEL, con la tinta del sistema y SIN radio: el
            papel cálido baja el contraste del módulo y un radio recorta los
            módulos de las esquinas. La zona de silencio la da el padding. */}
        <div
          className={`rounded-sm border-2 border-tinta bg-papel p-6 text-center shadow-solida transition-opacity ${
            done ? 'opacity-40' : ''
          }`}
        >
          {done && data!.status === 'completed' ? (
            <div className="py-10">
              <span aria-hidden="true" className="material-symbols-outlined text-[48px] text-verde">check_circle</span>
              <p className="mt-3 text-lg font-bold text-verde">¡Efectivo entregado!</p>
              <p className="text-[13px] text-gris">La operación fue completada con éxito.</p>
            </div>
          ) : (
            <>
              <QRCodeSVG
                value={qrPayload}
                size={220}
                bgColor="#fffdf8"
                fgColor="#16130f"
                level="M"
              />
              <div className="mt-4">
                <p className="num font-display text-[30px] font-extrabold leading-none text-naranja" translate="no">
                  ${data!.amount_mxn}{' '}
                  <span className="text-[16px] font-bold text-gris">MXN</span>
                </p>
                <p className="mt-1.5 text-[13px] text-gris">{data!.merchant_name}</p>
                <p className="num mt-1 text-[11px] text-gris">
                  {data!.amount_usdc} USDC bloqueados · Soroban HTLC
                </p>
              </div>
            </>
          )}
        </div>

        {!done && (
          <p className="mt-4 text-center text-[13px] text-gris">
            Expira en <span className="num font-bold text-tinta">{countdown}</span>
          </p>
        )}

        <p className="num mt-3 text-center text-[11px] text-gris">ID: {requestId}</p>

        <div className="mt-6 rounded-sm border-2 border-tinta bg-verde-suave p-4">
          <Label className="mb-2">Tus fondos están seguros</Label>
          <p className="text-[13px] leading-relaxed text-tinta">
            El USDC solo se libera cuando el comercio escanea este QR. Si no cobras, tu dinero
            regresa automáticamente al expirar.
          </p>
        </div>

        {data!.status === 'expired' && (
          <div className="mt-4 text-center">
            <SupportLink state="TRADE_EXPIRED" tradeId={requestId} />
          </div>
        )}
      </div>
    </div>
  );
}
