import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatMessages } from '../hooks/useChatMessages';
import { buildTxUrl } from '../utils/stellarExplorer';
import { parseTradeState, type TradeState } from '../components/TradeStateBadge';
import { getTrade, type TradeData } from '../services/api';
import TradeEscrowSummary from '../components/TradeEscrowSummary';

interface DepositChatProps {
    tradeId: string;
    userId: string;
    onBack: () => void;
    onViewQR: () => void;
    lockTxHash?: string | null;
    apiBaseUrl?: string;
    token?: string | null;
    counterpartyName?: string | null;
}

const DepositChat = ({
    tradeId,
    userId,
    onBack,
    onViewQR,
    lockTxHash,
    apiBaseUrl = 'http://localhost:3000',
    token,
    counterpartyName,
}: DepositChatProps) => {
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
    const [fetchedLockTxHash, setFetchedLockTxHash] = useState<string | null>(null);
    const [escrowStatus, setEscrowStatus] = useState<TradeState | null>(null);
    // WP-D: la operacion del servidor, para la cifra del escrow segun el rol.
    const [escrowTrade, setEscrowTrade] = useState<TradeData | null>(null);
    const displayLockTxHash = fetchedLockTxHash ?? lockTxHash;
    // Los fondos siguen en garantia despues del bloqueo: cuando el agente
    // confirma el efectivo la operacion pasa a `revealing`, y antes el aviso
    // volvia a rojo ("NO entregues el efectivo") con el escrow ya bloqueado.
    const fondosEnGarantia = escrowStatus === 'locked' || escrowStatus === 'revealing';

    // Auto-scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Poll the real trade so the lock tx hash shows up once the counterparty locks funds.
    useEffect(() => {
        if (!token || !tradeId) return;

        const fetchTradeStatus = async () => {
            try {
                const trade = await getTrade(tradeId, token);
                if (trade.lock_tx_hash) setFetchedLockTxHash(trade.lock_tx_hash);
                setEscrowStatus(parseTradeState(trade.status));
                setEscrowTrade(trade);
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

    return (
        <div className="bg-surface font-body text-on-surface min-h-screen flex flex-col">
            {/* TopAppBar */}
            <header className="flex items-center justify-between px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] w-full sticky top-0 z-50 bg-fondo border-b border-[#E7F6FF]">
                <div className="flex items-center gap-4">
                    <button 
                        onClick={onBack}
                        className="min-h-12 min-w-12 flex items-center justify-center p-2 text-verde hover:bg-[#E7F6FF] transition-colors rounded-sm active:translate-x-[2px] active:translate-y-[2px] duration-150"
                    >
                        <span className="material-symbols-outlined">arrow_back</span>
                    </button>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <h1 className="font-headline font-bold text-lg tracking-tight text-tinta">{counterpartyName ?? '—'}</h1>
                            <span className="bg-primary/10 text-primary text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 border border-primary/20">
                                <span className="material-symbols-outlined !text-[12px]" style={{ fontVariationSettings: '"FILL" 1' }}>verified</span>
                                {t('chatRoom.verified').toUpperCase()}
                            </span>
                        </div>
                        <span className="text-xs text-on-surface/60 font-medium">{t('chatRoom.authorizedAgent')}</span>
                    </div>
                </div>
            </header>

            <main className="flex-1 max-w-2xl mx-auto flex flex-col w-full bg-[radial-gradient(circle_at_2px_2px,rgba(0,105,76,0.03)_1px,transparent_0)] bg-[length:24px_24px]">
                {/* Status Banner */}
                <section className="px-6 py-4">
                    <div className="bg-papel border border-primary/10 rounded-sm p-4 flex items-start gap-3">
                        {/* Este cartel se pintaba SIEMPRE, con palomita verde,
                            diciendo "el agente bloqueó los activos que recibirás"
                            en el instante en que llegabas — sin mirar el estado
                            real y sin que el agente hubiera hecho nada todavía.
                            En la práctica bloquear tarda; anunciarlo antes de
                            tiempo puede hacer que alguien entregue efectivo
                            creyendo que hay garantía cuando no la hay. */}
                        <div className={`w-10 h-10 rounded-sm flex items-center justify-center shrink-0 ${fondosEnGarantia ? 'bg-primary/10 text-primary' : 'bg-naranja/10 text-naranja'}`}>
                            <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>
                                {fondosEnGarantia ? 'task_alt' : 'hourglass_top'}
                            </span>
                        </div>
                        <div className="flex flex-col gap-1 min-w-0">
                            <p className={`text-sm font-bold font-headline ${fondosEnGarantia ? 'text-primary' : 'text-naranja'}`}>
                                {fondosEnGarantia
                                    ? t('chatRoom.agentFoundTitle')
                                    : t('chatRoom.depositWaitingLockTitle')}
                            </p>
                            <p className="text-xs text-on-surface/60">
                                {fondosEnGarantia
                                    ? t('chatRoom.agentFoundDesc')
                                    : t('chatRoom.depositWaitingLockDesc')}
                            </p>
                            {displayLockTxHash ? (
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
                            )}
                        </div>
                    </div>
                    <TradeEscrowSummary trade={escrowTrade} viewerId={userId} className="mt-2 px-1" />
                </section>

                {/* Loading State */}
                {isLoading && (
                    <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                )}

                {/* Error State with Retry */}
                {error && !isLoading && (
                    <div className="px-6 py-4">
                        <div className="bg-red-50 border border-red-200 rounded-sm p-4 flex items-start gap-3">
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
                    </div>
                )}

                {/* Message List */}
                <div className="flex-grow px-6 py-4 flex flex-col gap-6">
                    {!isLoading && messages.length > 0 && (
                        <div className="flex justify-center">
                            <span className="bg-surface-container-low text-on-surface/40 text-[10px] font-bold tracking-widest px-3 py-1 rounded-full uppercase">{t('chatRoom.today')}</span>
                        </div>
                    )}

                    {!isLoading && !error && messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <span className="material-symbols-outlined text-[48px] text-gris/40 mb-3">chat_bubble</span>
                            <p className="text-sm text-on-surface/60 font-medium">{t('chatRoom.noMessagesYet')}</p>
                            <p className="text-xs text-on-surface/40 mt-1">{t('chatRoom.startConversation')}</p>
                        </div>
                    )}

                    {messages.map((msg) => (
                        <div 
                            key={msg.id}
                            className={`flex flex-col gap-2 ${msg.isOwn ? 'max-w-[85%] self-end' : 'max-w-[85%] self-start'}`}
                        >
                            <div className={`p-4 border ${
                                msg.isOwn
                                    ? 'bg-primary text-papel rounded-tl-2xl rounded-bl-2xl rounded-br-2xl border-primary ' 
                                    : 'bg-papel text-on-surface rounded-tr-2xl rounded-bl-2xl rounded-br-2xl border-surface-container-high'
                            }`}>
                                <p className="text-[15px] leading-relaxed">{msg.body}</p>
                            </div>
                            <div className={`flex items-center gap-1 mt-1 px-1 ${msg.isOwn ? 'justify-end' : ''}`}>
                                <span className="text-[10px] text-on-surface/40 font-semibold">
                                    {new Date(msg.createdAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })}
                                </span>
                                {msg.isOwn && (
                                    <span className="material-symbols-outlined !text-[12px] text-naranja" style={{ fontVariationSettings: msg.readAt ? '"FILL" 1' : '"FILL" 0' }}>done_all</span>
                                )}
                            </div>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>

                {/* Footer / Input */}
                <footer className="sticky bottom-0 bg-papel px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-4 flex flex-col gap-4 border-t border-[#E7F6FF]">
                    <div className="grid grid-cols-1 gap-3">
                        <button
                            onClick={onViewQR}
                            className="flex items-center justify-center gap-2 py-3 px-4 rounded-sm bg-naranja text-papel border-2 border-tinta shadow-solida font-bold text-sm hover:brightness-110 transition-all active:translate-x-[2px] active:translate-y-[2px] disabled:opacity-50"
                            disabled={isSending}
                        >
                            <span className="material-symbols-outlined !text-[20px]">qr_code_2</span>
                            {t('chatRoom.viewMyQrAgent')}
                        </button>
                    </div>
                    {sendError && (
                        <div className="text-xs text-red-600 bg-red-50 min-h-12 px-3 rounded-sm">
                            {t('chatRoom.sendFailed', { error: sendError.message })}
                        </div>
                    )}
                    <div className="flex items-center gap-3 bg-papel border-b border-linea py-2">
                        <div className="flex-grow">
                            <input 
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                className="w-full bg-transparent border-none focus:ring-0 text-sm font-medium placeholder:text-on-surface/30 disabled:opacity-50" 
                                placeholder={t('chatRoom.messagePlaceholder')}
                                type="text"
                                disabled={isSending}
                            />
                        </div>
                        <button 
                            onClick={handleSendMessage}
                            disabled={isSending || !inputValue.trim()}
                            className="min-h-12 min-w-12 rounded-sm bg-fondo border-2 border-tinta flex items-center justify-center text-primary hover:bg-primary hover:text-papel transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSending ? (
                                <div className="animate-spin rounded-full h-4 w-4 border-b border-current"></div>
                            ) : (
                                <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>send</span>
                            )}
                        </button>
                    </div>
                </footer>
            </main>
        </div>
    );
};

export default DepositChat;
