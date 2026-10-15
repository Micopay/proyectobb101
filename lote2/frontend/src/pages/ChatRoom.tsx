import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatMessages } from '../hooks/useChatMessages';
import { getTrade, type TradeData } from '../services/api';
import TradeEscrowSummary from '../components/TradeEscrowSummary';
import { buildTxUrl } from '../utils/stellarExplorer';
import { TRADE_STATE_COPY, parseTradeState } from '../components/TradeStateBadge';

/**
 * Redaccion humana de un estado, del mismo diccionario que usa la insignia.
 * Si llegara un estado desconocido —un backend nuevo, una version vieja de la
 * app— se dice algo honesto en vez de enseñar el identificador interno.
 */
function stateCopy(status: string): { label: string; next: string } {
    const parsed = parseTradeState(status);
    if (parsed) return TRADE_STATE_COPY[parsed];
    return {
        label: 'Operación en curso',
        next: 'Estamos verificando el estado con el servidor.',
    };
}


interface ChatRoomProps {
    tradeId: string;
    userId: string;
    onBack: () => void;
    onViewQR: () => void;
    lockTxHash?: string | null;
    apiBaseUrl?: string;
    token?: string | null;
    isProvider?: boolean;
    counterpartyName?: string | null;
}

const ChatRoom = ({
    tradeId,
    userId,
    onBack,
    onViewQR,
    lockTxHash,
    apiBaseUrl = 'http://localhost:3000',
    token,
    isProvider = false,
    counterpartyName,
}: ChatRoomProps) => {
    const { t } = useTranslation();
    const {
        messages,
        isLoading,
        error,
        sendMessage,
        isSending,
        sendError,
        retryLoad,
    } = useChatMessages({ tradeId, userId, token, apiBaseUrl });

    const [inputValue, setInputValue] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [escrowStatus, setEscrowStatus] = useState<string | null>(null);
    const [escrowAmount, setEscrowAmount] = useState<number | null>(null);
    // WP-D: la operacion del servidor, para la cifra del escrow segun el rol.
    const [escrowTrade, setEscrowTrade] = useState<TradeData | null>(null);
    const [fetchedLockTxHash, setFetchedLockTxHash] = useState<string | null>(null);
    const displayLockTxHash = fetchedLockTxHash ?? lockTxHash;

    // Auto-scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Poll the real trade so the buyer sees the lock confirm and its tx hash
    // (the merchant locks funds asynchronously — this device only creates the trade).
    useEffect(() => {
        if (!token || !tradeId) return;

        const fetchTradeStatus = async () => {
            try {
                const trade = await getTrade(tradeId, token);
                setEscrowStatus(trade.status);
                setEscrowAmount(trade.amount_mxn);
                setEscrowTrade(trade);
                if (trade.lock_tx_hash) setFetchedLockTxHash(trade.lock_tx_hash);
            } catch (e) {
                console.warn('Failed to fetch trade status', e);
            }
        };

        fetchTradeStatus();
        const interval = setInterval(fetchTradeStatus, 5000);
        return () => clearInterval(interval);
    }, [token, tradeId]);

    const handleSendMessage = async () => {
        if (!inputValue.trim()) return;
        
        const messageBody = inputValue;
        setInputValue('');
        await sendMessage(messageBody);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    };

    const formattedAmount = escrowAmount != null
        ? escrowAmount.toLocaleString('es-MX')
        : '…';

    const lockTxLink = displayLockTxHash ? (
        <a
            href={buildTxUrl(displayLockTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors font-mono truncate mt-1"
        >
            <span className="material-symbols-outlined text-[14px]">open_in_new</span>
            {t('chatRoom.viewOnStellarTestnet')}
            <span className="truncate opacity-60">· {displayLockTxHash.substring(0, 12)}…</span>
        </a>
    ) : (
        <p className="text-xs text-on-surface/40 mt-1">{t('chatRoom.confirmingOnChain')}</p>
    );

    return (
        <div className="bg-background text-on-surface font-body min-h-screen flex flex-col">
            {/* TopAppBar */}
            <header className="fixed top-0 w-full z-50 flex items-center px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] justify-between bg-surface/80 border-b-2 border-tinta">
                <div className="flex items-center gap-3">
                    <button 
                        onClick={onBack}
                        className="min-h-12 min-w-12 p-2 hover:bg-surface-container-low transition-colors rounded-sm text-primary"
                    >
                        <span className="material-symbols-outlined">arrow_back</span>
                    </button>
                    <div className="flex items-center gap-2">
                        <div className="w-10 h-10 rounded-sm bg-primary-container flex items-center justify-center text-papel font-bold">
                            {(counterpartyName ?? '—').slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                            <h1 className="font-headline font-bold text-lg tracking-tight leading-tight text-on-surface">
                                {counterpartyName ?? '—'}
                            </h1>
                            <div className="flex items-center gap-1">
                                <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: '"FILL" 1' }}>
                                    verified
                                </span>
                                <span className="text-[10px] font-bold text-primary tracking-widest uppercase">{t('chatRoom.verified')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* Content Area */}
            <main className="flex-1 mt-[calc(72px+env(safe-area-inset-top))] mb-24 px-4 max-w-2xl mx-auto w-full flex flex-col">
                {/* Status Banner - role-specific */}
                <div className="my-4 p-4 rounded-sm bg-primary-container/10 border border-primary/10 flex items-start gap-3">
                    {isProvider ? (
                        <>
                            <div className={`rounded-full p-1 flex items-center justify-center shrink-0 mt-0.5 text-papel ${
                                escrowStatus === 'locked' ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}>
                                <span className="material-symbols-outlined text-sm">
                                    {escrowStatus === 'locked' ? 'lock' : 'hourglass_top'}
                                </span>
                            </div>
                            <div className="flex flex-col gap-1 min-w-0">
                                {escrowStatus === 'locked' ? (
                                    <>
                                        <p className="text-sm font-semibold text-emerald-700">{t('chatRoom.cashoutAgentLockedTitle')}</p>
                                        <p className="text-xs text-emerald-600 font-medium">
                                            {t('chatRoom.cashoutAgentLockedDesc', { amount: formattedAmount })}
                                        </p>
                                    </>
                                ) : escrowStatus === 'pending' ? (
                                    <>
                                        <p className="text-sm font-semibold text-amber-700">{t('chatRoom.cashoutAgentPendingTitle')}</p>
                                        <p className="text-xs text-amber-600">{t('chatRoom.cashoutAgentPendingDesc')}</p>
                                    </>
                                ) : escrowStatus ? (
                                    // Los demás estados (revealing, completed, cancelled…) salen del
                                    // mismo diccionario que la insignia. Antes caían a
                                    // "Operación: revealing" — el nombre interno del sistema, en
                                    // mitad de una operación con dinero dentro.
                                    <>
                                        <p className="text-sm font-semibold text-on-surface">
                                            {stateCopy(escrowStatus).label}
                                        </p>
                                        <p className="text-xs text-on-surface/60">
                                            {stateCopy(escrowStatus).next}
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-xs text-on-surface/40">{t('chatRoom.verifyingEscrowStatus')}</p>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className={`rounded-full p-1 flex items-center justify-center shrink-0 mt-0.5 text-papel ${
                                escrowStatus === 'locked' ? 'bg-primary' : 'bg-amber-500'
                            }`}>
                                <span className="material-symbols-outlined text-sm">
                                    {escrowStatus === 'locked' ? 'check' : 'hourglass_top'}
                                </span>
                            </div>
                            <div className="flex flex-col gap-1 min-w-0">
                                {escrowStatus === 'locked' ? (
                                    <>
                                        <p className="text-sm font-semibold text-primary">{t('chatRoom.cashoutClientLockedTitle')}</p>
                                        <p className="text-xs text-on-surface/60">{t('chatRoom.cashoutClientLockedDesc')}</p>
                                        {lockTxLink}
                                    </>
                                ) : escrowStatus === 'pending' ? (
                                    <>
                                        <p className="text-sm font-semibold text-amber-700">{t('chatRoom.cashoutClientPendingTitle')}</p>
                                        <p className="text-xs text-amber-600">{t('chatRoom.cashoutClientPendingDesc')}</p>
                                        {lockTxLink}
                                    </>
                                ) : escrowStatus ? (
                                    // Los demás estados (revealing, completed, cancelled…) salen del
                                    // mismo diccionario que la insignia. Antes caían a
                                    // "Operación: revealing" — el nombre interno del sistema, en
                                    // mitad de una operación con dinero dentro.
                                    <>
                                        <p className="text-sm font-semibold text-on-surface">
                                            {stateCopy(escrowStatus).label}
                                        </p>
                                        <p className="text-xs text-on-surface/60">
                                            {stateCopy(escrowStatus).next}
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-xs text-on-surface/40">{t('chatRoom.verifyingEscrowStatus')}</p>
                                )}
                            </div>
                        </>
                    )}
                </div>

                <TradeEscrowSummary trade={escrowTrade} viewerId={userId} className="-mt-2 mb-2 px-1" />

                {/* Loading State */}
                {isLoading && (
                    <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                )}

                {/* Error State with Retry */}
                {error && !isLoading && (
                    <div className="my-4 p-4 rounded-sm bg-red-50 border border-red-200 flex items-start gap-3">
                        <span className="material-symbols-outlined text-red-600 text-lg">error</span>
                        <div className="flex flex-col gap-2 flex-1">
                            <p className="text-sm font-semibold text-red-700">{t('chatRoom.couldntLoadMessages')}</p>
                            <p className="text-xs text-red-600">{error.message}</p>
                            <button
                                onClick={retryLoad}
                                className="inline-flex min-h-12 items-center text-xs font-bold text-rojo underline"
                            >
                                {t('chatRoom.retry')}
                            </button>
                        </div>
                    </div>
                )}

                {/* Date Separator */}
                {!isLoading && messages.length > 0 && (
                    <div className="flex justify-center my-6">
                        <span className="text-[11px] font-bold text-gris uppercase tracking-widest bg-surface-container-low px-3 py-1 rounded-full">
                            {t('chatRoom.today')}
                        </span>
                    </div>
                )}

                {/* Empty State */}
                {!isLoading && !error && messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <span className="material-symbols-outlined text-[48px] text-gris/40 mb-3">chat_bubble</span>
                        <p className="text-sm text-on-surface/60 font-medium">{t('chatRoom.noMessagesYet')}</p>
                        <p className="text-xs text-on-surface/40 mt-1">{t('chatRoom.startConversation')}</p>
                    </div>
                )}

                {/* Messages List */}
                <div className="flex flex-col gap-6">
                    {messages.map((msg) => (
                        <div 
                            key={msg.id}
                            className={`flex flex-col max-w-[85%] ${msg.isOwn ? 'items-end self-end' : 'items-start'}`}
                        >
                            <div className={`p-4 rounded-t-2xl relative ${
                                msg.isOwn
                                    ? 'bg-primary text-on-primary rounded-bl-2xl rounded-br-none ' 
                                    : 'bg-surface-container-low text-on-surface rounded-br-2xl rounded-bl-none'
                            }`}>
                                <p className="text-sm leading-relaxed">{msg.body}</p>
                                {msg.id.startsWith('temp-') && (
                                    <div className="absolute top-1 right-1">
                                        <div className="animate-spin rounded-full h-3 w-3 border-b border-current"></div>
                                    </div>
                                )}
                            </div>
                            <div className={`flex items-center gap-1 mt-1 px-1 ${msg.isOwn ? 'justify-end' : ''}`}>
                                <span className="text-[10px] text-gris font-medium">
                                    {new Date(msg.createdAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })}
                                </span>
                                {msg.isOwn && (
                                    <span className="material-symbols-outlined text-[12px] text-primary" style={{ fontVariationSettings: msg.readAt ? '"FILL" 1' : '"FILL" 0' }}>
                                        done_all
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />

                    {/* Quick Actions Section */}
                    <div className="grid grid-cols-1 gap-3 mt-4">
                        {isProvider && escrowStatus === 'locked' && (
                            <button
                                onClick={onViewQR}
                                className="flex items-center justify-center gap-3 w-full h-[46px] rounded-sm bg-emerald-600 text-papel font-semibold hover:bg-emerald-700 transition-colors shadow-emerald-600/20"
                            >
                                <span className="material-symbols-outlined">qr_code_scanner</span>
                                <span className="font-body text-sm">{t('chatRoom.scanClientQr')}</span>
                            </button>
                        )}
                        <button
                            onClick={onViewQR}
                            className="flex items-center justify-center gap-3 w-full h-[46px] rounded-sm bg-primary text-papel font-semibold hover:opacity-90 transition-opacity "
                        >
                            <span className="material-symbols-outlined">qr_code_2</span>
                            <span className="font-body text-sm">{t('chatRoom.viewMyQr')}</span>
                        </button>
                    </div>
                </div>
            </main>

            {/* Bottom Chat Input */}
            <div className="fixed bottom-0 w-full bg-surface/80 px-4 pt-3 pb-[max(2rem,env(safe-area-inset-bottom))] border-t border-surface-container">
                <div className="max-w-2xl mx-auto flex flex-col gap-2">
                    {sendError && (
                        <div className="text-xs text-red-600 bg-red-50 min-h-12 px-3 rounded-sm">
                            {t('chatRoom.sendFailed', { error: sendError.message })} <button onClick={() => {}} className="underline ml-1">{t('chatRoom.retry')}</button>
                        </div>
                    )}
                    <div className="flex items-end gap-3">
                        <div className="flex-1 flex items-center">
                            <textarea
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                className="w-full bg-surface-container-low border-none focus:ring-2 focus:ring-primary rounded-sm py-3 px-4 text-sm text-on-surface placeholder:text-outline resize-none overflow-hidden disabled:opacity-50"
                                placeholder={t('chatRoom.messagePlaceholder')}
                                rows={1}
                                disabled={isSending}
                            />
                        </div>
                        <button 
                            onClick={handleSendMessage}
                            disabled={isSending || !inputValue.trim()}
                            className="w-11 h-11 bg-primary text-papel rounded-sm flex items-center justify-center hover:scale-105 active:translate-x-[2px] active:translate-y-[2px] transition-all mb-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSending ? (
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                            ) : (
                                <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>send</span>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ChatRoom;
