import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { completeTrade, getTrade, TradeData } from '../services/api';
import TradeEscrowSummary from '../components/TradeEscrowSummary';
import { shouldKeepPollingTrade } from '../utils/escrowAmounts';

const DEPOSIT_QR_POLL_MS = 5000;

interface DepositQRProps {
    activeTrade: TradeData | null;
    buyerToken: string | null;
    /**
     * H4: quien mira (el cliente que deposita), para mostrar lo que va a
     * recibir. Esta es la pantalla que abre el cliente desde el chat de
     * deposito; antes no mostraba ni el activo ni la cantidad.
     */
    viewerId?: string | null;
    onBack: () => void;
    onChat: () => void;
    onSuccess: (releaseTxHash: string) => void;
}

const DepositQR = ({ activeTrade, buyerToken, viewerId, onBack, onChat, onSuccess }: DepositQRProps) => {
    const { t } = useTranslation();
    const [isConfirming, setIsConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // H4: la operacion del servidor. `activeTrade` es la respuesta de crearla
    // y no cambia; el bloqueo del agente llega despues.
    const [serverTrade, setServerTrade] = useState<TradeData | null>(null);
    const displayTrade = serverTrade ?? activeTrade;
    const keepPolling = serverTrade ? shouldKeepPollingTrade(serverTrade) : true;

    useEffect(() => {
        if (!activeTrade || !buyerToken || !keepPolling) return;
        let cancelled = false;
        const load = async () => {
            try {
                const fresh = await getTrade(activeTrade.id, buyerToken);
                if (!cancelled) setServerTrade(fresh);
            } catch {
                // Sin datos del servidor se muestra lo que ya habia; no se inventa.
            }
        };
        load();
        const interval = setInterval(load, DEPOSIT_QR_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [activeTrade, buyerToken, keepPolling]);

    // El agente confirma el efectivo escaneando este QR (o desde su pantalla
    // de la operación). Hasta entonces el servidor rechaza la liberación, así
    // que el botón espera a `revealing` en vez de fallar con un error.
    const cashConfirmed = displayTrade?.status === 'revealing';

    const handleComplete = async () => {
        if (!activeTrade || !buyerToken || !cashConfirmed || isConfirming) return;
        setIsConfirming(true);
        setError(null);
        try {
            const result = await completeTrade(activeTrade.id, buyerToken);
            setTimeout(() => onSuccess(result.release_tx_hash), 1500);
        } catch (e) {
            console.error('Deposit completion failed', e);
            setIsConfirming(false);
            setError('No se pudo completar el depósito. Intenta de nuevo.');
        }
    };

    return (
        <div className="bg-surface font-body text-on-surface min-h-screen flex flex-col">
            {/* TopAppBar */}
            <header className="border-b-2 border-tinta bg-fondo w-full top-0 sticky flex items-center justify-between px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] z-50">
                <div className="flex items-center gap-3">
                    <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 text-verde active:translate-x-[2px] active:translate-y-[2px] duration-200">
                        <span className="material-symbols-outlined">arrow_back</span>
                    </button>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-1">
                            <h1 className="font-headline font-bold text-xl text-tinta">Depósito</h1>
                            <span className="material-symbols-outlined text-verde text-[18px]" style={{ fontVariationSettings: '"FILL" 1' }}>verified</span>
                        </div>
                        <span className="text-[10px] tracking-wide uppercase font-semibold text-primary">Agente Autorizado</span>
                    </div>
                </div>
                <div className="w-10 h-10 rounded-sm bg-primary-container flex items-center justify-center text-papel">
                    <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>person</span>
                </div>
            </header>

            <main className="flex-1 px-6 pt-4 pb-32 max-w-md mx-auto w-full space-y-6">
                {/* Status Banner */}
                <div className="bg-primary/10 rounded-sm p-4 flex items-center gap-3 border border-primary/20">
                    <div className="flex h-2 w-2 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                    </div>
                    <p className="font-headline font-bold text-primary tracking-tight">Ve al agente y entrégale el efectivo</p>
                </div>

                {/* Chat Preview */}
                <section>
                    <div className="bg-surface-container-lowest border-2 border-tinta p-4 rounded-sm ">
                        <div className="flex gap-3 mb-4">
                            <div className="w-10 h-10 rounded-sm bg-emerald-100 flex-shrink-0 flex items-center justify-center">
                                <span className="material-symbols-outlined text-emerald-700 text-lg">storefront</span>
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-on-surface-variant leading-snug">
                                    <span className="font-bold text-on-surface">Agente:</span> Ya recibí tu solicitud.
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={onChat}
                                className="flex-1 min-h-12 px-4 rounded-sm border-2 border-tinta bg-papel text-tinta font-bold font-bold text-xs hover:bg-primary/5 transition-colors flex items-center justify-center gap-2"
                            >
                                <span className="material-symbols-outlined text-sm">chat</span>
                                Abrir chat
                            </button>
                            <button className="flex-1 min-h-12 px-4 rounded-sm border-2 border-tinta bg-papel text-tinta font-bold font-bold text-xs hover:bg-primary/5 transition-colors flex items-center justify-center gap-2">
                                <span className="material-symbols-outlined text-sm">location_on</span>
                                Compartir ubicación
                            </button>
                        </div>
                    </div>
                </section>

                {/* QR Content Card */}
                <div className="bg-surface-container-low rounded-sm p-8 flex flex-col items-center space-y-6 ">
                    <div className="bg-papel p-6 rounded-sm border-2 border-tinta">
                        <QRCodeSVG
                            value={`micopay://confirm?trade_id=${activeTrade?.id ?? ''}`}
                            size={192}
                            bgColor="transparent"
                            fgColor="#16130f"
                            level="M"
                        />
                    </div>
                    <div className="text-center space-y-2">
                        <p className="font-bold text-[11px] tracking-[0.15em] text-primary uppercase">MUESTRA ESTE CÓDIGO AL AGENTE</p>
                        {displayTrade ? (
                            <p className="num font-headline font-black text-2xl text-on-surface">${displayTrade.amount_mxn} MXN</p>
                        ) : null}
                        <TradeEscrowSummary trade={displayTrade} viewerId={viewerId} />
                    </div>
                </div>

                {/* Info */}
                <div className="bg-surface-container-lowest rounded-sm p-4 flex gap-4 items-start border-2 border-tinta ">
                    <span className="material-symbols-outlined text-primary shrink-0">info</span>
                        <p className="text-[13px] leading-relaxed text-on-surface/80">
                        Entrega el efectivo al agente. Al recibirlo, escaneará este código y entonces podrás recibir tus activos.
                    </p>
                </div>

                {/* Error display */}
                {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-sm text-red-700 text-sm font-medium text-center">
                        {error}
                    </div>
                )}

                {/* Confirm Section */}
                <div className="pt-4">
                    {!isConfirming ? (
                        <button
                            onClick={handleComplete}
                            disabled={!activeTrade || !buyerToken || !cashConfirmed}
                            className="w-full h-[52px] bg-primary text-papel font-bold rounded-sm flex items-center justify-center gap-2 active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-40"
                        >
                            <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                            {cashConfirmed ? 'Recibir mis activos' : 'Esperando que el agente confirme el efectivo…'}
                        </button>
                    ) : (
                        <div className="flex flex-col items-center gap-3 py-6">
                            <div className="relative w-8 h-8">
                                <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
                                <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                            </div>
                            <p className="text-sm font-medium text-gris">Liberando tus activos digitales…</p>
                        </div>
                    )}
                    <p className="text-[11px] text-gris text-center mt-4 leading-relaxed px-2">
                        {cashConfirmed
                            ? 'El agente confirmó que recibió tu efectivo.'
                            : 'El botón se activa cuando el agente escanea tu código.'}
                    </p>
                </div>
            </main>
        </div>
    );
};

export default DepositQR;
