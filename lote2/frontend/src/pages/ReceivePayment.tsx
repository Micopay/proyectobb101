import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { ASSETS, SENDABLE_ASSETS } from '../constants/assets';
import { ensureTrustline, hasTrustline } from '../services/payment';
import { ESCROW_ASSET_OPTIONS } from '../constants/escrowAssets';

type TrustState = 'checking' | 'active' | 'inactive' | 'activating';

/**
 * Activos emitidos que se pueden usar en el escrow de este build: los que el
 * usuario necesita recibir para retirar efectivo. Cada uno pide trustline.
 */
const ESCROW_CODES = ESCROW_ASSET_OPTIONS.filter((o) => o.enabled).map((o) => o.code.toUpperCase());
const ISSUED_ASSETS = SENDABLE_ASSETS.filter((a) => !a.native && ESCROW_CODES.includes(a.code.toUpperCase()));

interface ReceivePaymentProps {
  address: string | null;
  onBack: () => void;
}

const ReceivePayment = ({ address, onBack }: ReceivePaymentProps) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Un activo emitido (USDC) solo se puede recibir con trustline. Sin este
  // boton la app no tenia donde crearla, asi que nadie podia recibir USDC.
  const [trust, setTrust] = useState<Record<string, TrustState>>({});
  const [trustError, setTrustError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let active = true;
    for (const a of ISSUED_ASSETS) {
      setTrust((t) => ({ ...t, [a.code]: 'checking' }));
      hasTrustline(a.code)
        .then((ok) => active && setTrust((t) => ({ ...t, [a.code]: ok ? 'active' : 'inactive' })))
        .catch(() => active && setTrust((t) => ({ ...t, [a.code]: 'inactive' })));
    }
    return () => {
      active = false;
    };
  }, [address]);

  const activate = async (code: string) => {
    setTrustError(null);
    setTrust((t) => ({ ...t, [code]: 'activating' }));
    try {
      await ensureTrustline(code);
      setTrust((t) => ({ ...t, [code]: 'active' }));
    } catch (e) {
      setTrust((t) => ({ ...t, [code]: 'inactive' }));
      setTrustError(e instanceof Error && e.message ? e.message : t('receive.activateFailed', { code }));
    }
  };

  const handleCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
        <button onClick={onBack} aria-label={t('send.cancel')} className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-surface-container-low transition-colors">
          <span className="material-symbols-outlined text-verde">arrow_back</span>
        </button>
        <h1 className="font-headline font-bold text-lg">{t('receive.title')}</h1>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-6 pb-24 flex flex-col items-center max-w-md mx-auto w-full">
        <p className="text-sm text-on-surface-variant text-center mb-6">
          {t('receive.subtitle')}
        </p>

        {address ? (
          <div className="bg-papel p-6 rounded-sm border-2 border-tinta flex flex-col items-center">
            <QRCodeSVG value={address} size={216} bgColor="transparent" fgColor="#16130f" level="M" />
          </div>
        ) : (
          <div className="bg-surface-container-low p-8 rounded-sm text-center text-sm text-gris">
            {t('profile.noKeyGenerated')}
          </div>
        )}

        {address && (
          <>
            <div className="mt-6 w-full bg-surface-container-low rounded-sm p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-1">{t('receive.yourAddress')}</p>
              <p className="font-mono text-xs text-on-surface break-all select-all">{address}</p>
            </div>

            <button
              onClick={handleCopy}
              className="mt-4 w-full h-12 bg-primary text-papel font-bold rounded-sm flex items-center justify-center gap-2 active:translate-x-[2px] active:translate-y-[2px] transition-all"
            >
              <span className="material-symbols-outlined text-lg">{copied ? 'check' : 'content_copy'}</span>
              {copied ? t('receive.copied') : t('receive.copy')}
            </button>
          </>
        )}

        <div className="mt-8 w-full bg-surface-container-lowest border-2 border-tinta rounded-sm p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-3">{t('receive.accepts')}</p>
          <div className="flex flex-wrap gap-2">
            {ASSETS.map((a) => (
              <span key={a.code} className="px-3 py-1 rounded-sm border-2 border-tinta bg-verde text-papel text-xs font-bold" >
                {a.code}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gris mt-3 leading-relaxed">
            {t('receive.scanTip')}
          </p>
          {address && ISSUED_ASSETS.map((a) => {
            const state = trust[a.code];
            if (state === 'active' || state === undefined || state === 'checking') return null;
            return (
              <div key={a.code} className="mt-4 border-t-2 border-tinta pt-4">
                <p className="text-[11px] text-gris mb-2 leading-relaxed">{t('receive.activateHint', { code: a.code })}</p>
                <button
                  onClick={() => activate(a.code)}
                  disabled={state === 'activating'}
                  className="w-full h-12 border-2 border-tinta bg-papel text-tinta font-bold rounded-sm flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  <span className="material-symbols-outlined text-lg">add_circle</span>
                  {state === 'activating' ? t('receive.activating') : t('receive.activate', { code: a.code })}
                </button>
              </div>
            );
          })}
          {trustError && <p role="alert" className="text-[11px] text-error mt-2">{trustError}</p>}
        </div>
      </main>
    </div>
  );
};

export default ReceivePayment;
