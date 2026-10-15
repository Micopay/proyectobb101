import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { App as CapApp } from '@capacitor/app';
import { QRCodeSVG } from 'qrcode.react';
import { getSecret, revealTrade, lockTrade, getTrade, TradeData } from '../services/api';
import { getTradeStateDebugOverride, normalizeTradeState, TradeState } from '../components/TradeStateBadge';
import ErrorBanner from '../components/ErrorBanner';
import SupportLink from '../components/SupportLink';
import { mapApiError, type MappedApiError } from '../utils/apiError';
import { getDemoQrPayload, IS_DEMO_MODE } from '../utils/demoMode';
import { buildTxUrl, STELLAR_NETWORK_LABEL } from '../utils/stellarExplorer';
import { useCountdown } from '../hooks/useCountdown';
import TradeEscrowSummary from '../components/TradeEscrowSummary';
import { assertNoClientPreparationForLock } from '../utils/escrowLock';

interface QRRevealProps {
    activeTrade: TradeData | null;
    /** CASH-7: un solo token de sesion; el rol se deriva del trade. */
    token: string | null;
    /**
     * WP-D: quien mira, para elegir la cifra del escrow que le toca. El monto ya
     * no llega como prop: antes era `activeAmount`, estado local de la pantalla
     * de monto; ahora sale de la operacion del servidor.
     */
    viewerId?: string | null;
    /** Counterparty shown in the header — who the seller is meeting. */
    counterpartyName?: string | null;
    /** The current (seller) device's own username, shown on the QR card so
     * the counterparty can visually confirm they're scanning the right person's code. */
    ownName?: string | null;
    onBack: () => void;
    onChat: () => void;
    onSuccess: (releaseTxHash: string) => void;
}

const QRReveal = ({ activeTrade, token, viewerId, counterpartyName, ownName, onBack, onChat, onSuccess }: QRRevealProps) => {
    const { t } = useTranslation();
    // WP-D: la ultima version de la operacion que devolvio el servidor.
    const [serverTrade, setServerTrade] = useState<TradeData | null>(null);
    const displayTrade = serverTrade ?? activeTrade;
    const [qrPayload, setQrPayload] = useState<string | null>(null);
    const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
    const [secretLoaded, setSecretLoaded] = useState(false);
    const [secretLoading, setSecretLoading] = useState(false);
    const [secretError, setSecretError] = useState<MappedApiError | null>(null);
    const [lockTxHash, setLockTxHash] = useState<string | null>(null);
    const [completedTxHash, setCompletedTxHash] = useState<string | null>(null);
    const [tradeState, setTradeState] = useState<TradeState>('locked');

    const loadSecret = useCallback(async () => {
        if (!activeTrade || !token) return;

        setSecretLoading(true);
        setSecretError(null);

        try {
            // This is the seller's own screen, so drive the whole
            // pending -> locked -> revealing chain here if needed — nothing
            // else in the app triggers the lock/reveal steps on its own.
            // El estado local puede venir viejo: desde que el bloqueo ocurre al
            // confirmar, para cuando se llega aqui la operacion suele estar ya
            // bloqueada. Se pregunta al servidor antes de decidir.
            //
            // Sin esto se intentaba bloquear una operacion ya bloqueada, el
            // servidor respondia 409 y la app lo traducia a "otra persona movio
            // esta operacion antes que tu" — un mensaje que hablaba de un
            // conflicto entre personas donde solo habia estado desactualizado.
            const current = await getTrade(activeTrade.id, token).catch(() => null);
            if (current) setServerTrade(current);
            const status = current?.status ?? activeTrade.status;

            if (status === 'pending') {
                // H3: el activo sale de la OPERACION del servidor, no de la
                // configuracion del APK, y no se envia ningun ChangeTrust previo.
                assertNoClientPreparationForLock(current?.asset_code ?? activeTrade.asset_code);
                await lockTrade(activeTrade.id, token);
            }
            // Swallow errors here: if the trade was already revealed (stale
            // local status), the reveal call 409s but getSecret still works.
            await revealTrade(activeTrade.id, token).catch(() => {});
            const { qr_payload, expires_at } = await getSecret(activeTrade.id, token);
            setQrPayload(qr_payload);
            setQrExpiresAt(expires_at);
            setSecretLoaded(true);

            const fresh = await getTrade(activeTrade.id, token).catch(() => null);
            if (fresh) setServerTrade(fresh);
            if (fresh?.lock_tx_hash) setLockTxHash(fresh.lock_tx_hash);
        } catch (e) {
            if (IS_DEMO_MODE) {
                setQrPayload(getDemoQrPayload());
                setQrExpiresAt(null);
                setSecretLoaded(true);
            } else {
                setSecretError(mapApiError(e));
                setQrPayload(null);
                setSecretLoaded(false);
            }
        } finally {
            setSecretLoading(false);
        }
    }, [activeTrade, token]);

    useEffect(() => {
        loadSecret();
    }, [loadSecret]);

    // Only the buyer can call release() — this device is the seller, so poll
    // until the counterparty completes it instead of trying to do it here.
    useEffect(() => {
        if (!activeTrade || !token || !secretLoaded) return;

        const poll = async () => {
            try {
                const fresh = await getTrade(activeTrade.id, token);
                setServerTrade(fresh);
                if (fresh.status === 'completed' && fresh.release_tx_hash) {
                    setCompletedTxHash(fresh.release_tx_hash);
                }
            } catch {
                // keep polling
            }
        };

        poll();
        const interval = setInterval(poll, 4000);
        return () => clearInterval(interval);
    }, [activeTrade, token, secretLoaded]);

    useEffect(() => {
        if (completedTxHash) {
            const timer = setTimeout(() => onSuccess(completedTxHash), 1500);
            return () => clearTimeout(timer);
        }
    }, [completedTxHash, onSuccess]);

    useEffect(() => {
        // CASH-5A: antes esto convertia el estado real `revealing` en un
        // `revealed` que ningun backend emite. El estado en que queda un trade
        // con el secreto ya cargado ES `revealing`; no hay nada que traducir.
        const fallbackState: TradeState = secretLoaded ? 'revealing' : 'locked';
        const backendState = normalizeTradeState(activeTrade?.status, fallbackState);
        setTradeState(getTradeStateDebugOverride(backendState));
    }, [activeTrade?.status, secretLoaded]);



    // UX_MANIFESTO, pantalla QR: "make expiration visible". El código caduca
    // antes que el trade, así que expirado NO significa fondos perdidos —
    // basta con pedir uno nuevo.
    const { label: qrCountdown, expired: qrExpired } = useCountdown(qrExpiresAt);
    const showQr = secretLoaded && qrPayload && !secretError && !qrExpired;

    return (
        <div className="bg-surface font-body text-on-surface min-h-screen">
            {/* Top Navigation */}
            <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
                <div className="flex items-center gap-3">
                    <button onClick={onBack} aria-label="Volver" className="min-h-12 min-w-12 min-h-12 min-w-12 flex items-center justify-center rounded-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary">
                        <span aria-hidden="true" className="material-symbols-outlined text-verde">arrow_back</span>
                    </button>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <h1 className="font-headline font-bold text-lg text-on-surface">{counterpartyName ?? '—'}</h1>
                            <span className="bg-secondary-container text-secondary text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">{t('qrReveal.verified')}</span>
                        </div>
                    </div>
                </div>
                {/* Aqui habia un boton de "Mas opciones" recuadrado, sin ningun
                    onClick: no hacia nada al pulsarlo y descuadraba la esquina
                    superior derecha. Un boton muerto es peor que ninguno —
                    promete una accion que no existe. Vuelve el dia que haya
                    opciones que ofrecer. */}
            </header>

            <main className="pt-[calc(6rem+env(safe-area-inset-top))] pb-12 px-6 max-w-md mx-auto">
                {/* Status Banner */}
                <div className="mb-8">
                    <div className="inline-flex items-center gap-2 bg-primary-container/10 border border-primary-container/20 px-4 py-2 rounded-full">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                        <span className="text-primary font-semibold text-sm">
                            {secretLoaded ? t('qrReveal.onchainEscrowLocked') : t('qrReveal.offerAcceptedLocked')}
                        </span>
                    </div>
                </div>

                {/* Chat / location quick actions — no fake message preview (see
                    docs/AUDIT_MOBILE_MAINNET.md, "mensaje de chat falso en QRReveal";
                    a static placeholder attributed to the real counterparty was
                    misleading). Real messages live in the chat screen itself. */}
                <section className="mb-10">
                    <div className="bg-surface-container-lowest border-2 border-tinta p-4 rounded-sm ">
                        <div className="flex items-center gap-3 mb-4">
                            {/* Era una foto de stock remota con alt="Pharmacist".
                                En la pantalla del dinero en vuelo, un hueco de
                                imagen rota por falta de senal es lo ultimo que
                                queremos: inicial de la contraparte, dibujada
                                local. */}
                            <div className="w-10 h-10 rounded-sm border-2 border-tinta bg-verde-suave flex-shrink-0 flex items-center justify-center font-headline font-extrabold text-verde">
                                {(counterpartyName ?? '—').trim().charAt(0).toUpperCase()}
                            </div>
                            <p className="text-sm font-bold text-on-surface">{counterpartyName ?? '—'}</p>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={onChat}
                                aria-label="Abrir chat con el agente"
                                className="flex-1 min-h-12 px-4 rounded-sm border-2 border-tinta bg-papel text-tinta font-bold font-bold text-sm hover:bg-primary/5 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">chat</span>
                                {t('qrReveal.openChat')}
                            </button>
                            <button aria-label="Ver ubicación del agente" className="flex-1 min-h-12 px-4 rounded-sm border-2 border-tinta bg-papel text-tinta font-bold font-bold text-sm hover:bg-primary/5 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary">
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">location_on</span>
                                {t('qrReveal.location')}
                            </button>
                        </div>
                    </div>
                </section>

                {/* QR Section */}
                <section className="mb-10 text-center">
                    <h2 className="text-[11px] font-bold text-gris uppercase tracking-[0.2em] mb-6">{t('qrReveal.exchangeCode')}</h2>

                    {secretLoading ? (
                        <div className="flex flex-col items-center gap-3 py-12">
                            <div className="relative w-8 h-8">
                                <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
                                <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                            </div>
                            <p className="text-sm font-medium text-gris">{t('qrReveal.generatingCode')}</p>
                        </div>
                    ) : secretError ? (
                        <ErrorBanner
                            variant="blocking"
                            message={secretError.message}
                            action={secretError.action}
                            onRetry={loadSecret}
                            supportTradeId={activeTrade?.id}
                            supportState="QR_REVEAL_SECRET"
                        />
                    ) : qrExpired ? (
                        <div className="flex flex-col items-center gap-4 py-10">
                            <span aria-hidden="true" className="material-symbols-outlined text-outline text-4xl">timer_off</span>
                            <p className="text-sm font-semibold text-on-surface">{t('qrReveal.codeExpired')}</p>
                            <p className="text-xs text-outline max-w-xs">{t('qrReveal.codeExpiredFunds')}</p>
                            <button
                                onClick={loadSecret}
                                className="mt-1 px-5 py-2.5 rounded-full bg-primary text-on-primary text-sm font-bold hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                {t('qrReveal.newCode')}
                            </button>
                        </div>
                    ) : showQr ? (
                        <div className="bg-papel p-8 rounded-sm inline-block mx-auto mb-6 border-2 border-tinta ">
                            <QRCodeSVG
                                value={qrPayload}
                                size={224}
                                bgColor="transparent"
                                fgColor="#16130f"
                                level="M"
                            />
                            <div className="mt-6">
                                <h3 className="font-headline font-extrabold text-xl text-on-surface">{ownName ?? '—'}</h3>
                                {displayTrade ? (
                                    <p className="num mt-2 font-headline font-black text-2xl text-on-surface">${displayTrade.amount_mxn} MXN</p>
                                ) : null}
                                <TradeEscrowSummary trade={displayTrade} viewerId={viewerId} className="mt-1" />
                                {qrCountdown && (
                                    <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">timer</span>
                                        {t('qrReveal.codeExpiresIn', { time: qrCountdown })}
                                    </p>
                                )}
                                {secretLoaded && (
                                    <p className="text-[10px] text-primary mt-1 font-mono opacity-70">
                                        {t('qrReveal.htlcTestnet', { network: STELLAR_NETWORK_LABEL })}
                                    </p>
                                )}
                                {lockTxHash && (
                                    <a
                                        href={buildTxUrl(lockTxHash)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mt-2 flex items-center justify-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors font-mono"
                                    >
                                        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                                        {t('qrReveal.viewLockOnExplorer')}
                                    </a>
                                )}
                            </div>
                        </div>
                    ) : null}
                </section>

                {/* Buyer completion status — this device (seller) can only wait */}
                {showQr && (
                    <section className="mb-10 text-center">
                        {completedTxHash ? (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <span aria-hidden="true" className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                                <p className="text-sm font-semibold text-primary">{t('qrReveal.released')}</p>
                                <a
                                    href={buildTxUrl(completedTxHash)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors font-mono"
                                >
                                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                                    {t('chatRoom.viewOnStellarTestnet')}
                                </a>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <div className="relative w-8 h-8">
                                    <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
                                    <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                                </div>
                                <p className="text-sm font-medium text-gris">{t('qrReveal.waitingForBuyer')}</p>
                            </div>
                        )}
                    </section>
                )}

                <footer className="mt-12 text-center pb-10 space-y-3">
                    <p className="text-[12px] text-gris leading-relaxed px-6 font-medium">
                        {t('qrReveal.autoCancelNotice')}
                    </p>
                    <SupportLink tradeId={activeTrade?.id} state="QR_REVEAL" />
                </footer>
            </main>
        </div>
    );
};

export default QRReveal;
