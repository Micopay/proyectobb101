import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountField } from '../components/ui';
import AssetSelector from '../components/AssetSelector';

export interface CashoutRequestProps {
  onBack: () => void;
  onSearch: (amount: number) => void;
  /** WP-C: clave de `ESCROW_ASSET_OPTIONS`; vive en el contexto de la app. */
  assetKey: string;
  onAssetChange: (key: string) => void;
}

const CashoutRequest = ({ onBack, onSearch, assetKey, onAssetChange }: CashoutRequestProps) => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('500');

  return (
    <div className="text-on-surface antialiased overflow-x-hidden min-h-screen bg-surface-container-low">
      <header className="border-b-2 border-tinta fixed top-0 w-full z-50 bg-surface-container-low pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              aria-label="Volver"
              className="min-h-12 min-w-12 text-primary active:translate-x-[2px] active:translate-y-[2px] duration-200 p-2 hover:bg-primary/10 rounded-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <span aria-hidden="true" className="material-symbols-outlined font-bold">arrow_back</span>
            </button>
            <h1 className="font-headline font-bold text-xl tracking-tight text-tinta">
              {t('cashout.title')}
            </h1>
          </div>
          <div className="w-10"></div>
        </div>
        <div className="bg-outline-variant/30 h-[1px] w-full self-end"></div>
      </header>

      <main className="pt-[calc(6rem+env(safe-area-inset-top))] pb-32 px-6 flex flex-col min-h-screen max-w-md mx-auto">
        {/* Aqui se pintaba la insignia de estado de una operacion con el estado
            fijado a mano en `pending`. Pero en esta pantalla NO EXISTE ninguna
            operacion: aun no se elige agente ni se confirma nada. Decia
            "Operacion creada · la solicitud se registro" — en pasado, afirmando
            un hecho que no habia ocurrido, dos pantallas antes de confirmar.

            La intencion era buena (principio 2 del manifiesto: la persona
            siempre sabe donde esta su dinero) pero se cumplia con una mentira.
            Se conserva la tranquilidad y se quita la afirmacion falsa. */}
        <p className="mb-6 text-sm text-on-surface-variant">
          {t('cashout.nothingMovedYet')}
        </p>
        <div className="mt-8 mb-4">
          <label htmlFor="cashout-amount" className="font-label text-xs font-bold tracking-[0.15em] text-on-surface-variant opacity-70">
            {t('cashout.amountLabel')}
          </label>
        </div>

        <AmountField
          id="cashout-amount"
          divisa="MXN"
          className="mb-8"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        <div className="mb-8">
          <AssetSelector
            flow="cashout"
            amountMxn={amount.trim() === '' ? null : Number(amount)}
            value={assetKey}
            onChange={onAssetChange}
          />
        </div>

        <div className="space-y-6">
          <div className="p-6 bg-surface-container-low rounded-sm border-l-4 border-primary/20">
            <div className="flex gap-4">
              <span aria-hidden="true" className="material-symbols-outlined text-primary opacity-60">info</span>
              <p className="font-body text-[14px] leading-relaxed text-on-surface-variant font-medium">
                {t('cashout.info')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface-container-highest/30 p-4 rounded-sm flex flex-col gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-verde">location_on</span>
              <span className="text-xs font-bold text-on-surface-variant">{t('cashout.location')}</span>
              <span className="text-sm font-semibold text-on-surface">{t('cashout.locationValue')}</span>
            </div>
            <div className="bg-surface-container-highest/30 p-4 rounded-sm flex flex-col gap-2">
              <span aria-hidden="true" className="material-symbols-outlined text-verde">speed</span>
              <span className="text-xs font-bold text-on-surface-variant">{t('cashout.time')}</span>
              <span className="text-sm font-semibold text-on-surface">{t('cashout.timeValue')}</span>
            </div>
          </div>
        </div>

        <div className="mt-auto pt-10 pb-6">
          <button
            onClick={() => onSearch(Number(amount))}
            aria-label="Buscar ofertas de efectivo"
            className="w-full bg-naranja text-papel border-2 border-tinta shadow-solida font-body font-semibold py-4 rounded-sm active:translate-x-[2px] active:translate-y-[2px] duration-200 transition-all flex items-center justify-center gap-3 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <span>{t('cashout.search')}</span>
            <span aria-hidden="true" className="material-symbols-outlined text-lg">search</span>
          </button>
        </div>
      </main>

      <div className="fixed top-0 right-0 -z-10 w-64 h-64 bg-primary/5 rounded-full blur-3xl -mr-32 -mt-32" />
      <div className="fixed bottom-0 left-0 -z-10 w-96 h-96 bg-primary-container/5 rounded-full blur-3xl -ml-48 -mb-48" />
    </div>
  );
};

export default CashoutRequest;
