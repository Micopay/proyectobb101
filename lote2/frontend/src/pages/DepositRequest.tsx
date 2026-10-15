import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountField } from '../components/ui';
import AssetSelector from '../components/AssetSelector';

export interface DepositRequestProps {
  onBack: () => void;
  onSearch: (amount: string) => void;
  /** WP-C: clave de `ESCROW_ASSET_OPTIONS`; vive en el contexto de la app. */
  assetKey: string;
  onAssetChange: (key: string) => void;
}

const DepositRequest = ({ onBack, onSearch, assetKey, onAssetChange }: DepositRequestProps) => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('500');

  return (
    <div className="bg-fondo min-h-screen text-on-surface font-body">
      <header className="border-b-2 border-tinta w-full top-0 sticky bg-fondo z-40 transition-colors duration-300 pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4 w-full">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              aria-label="Volver"
              className="min-h-12 min-w-12 text-verde hover:opacity-80 transition-opacity active:translate-x-[2px] active:translate-y-[2px] duration-200 focus:outline-none focus:ring-2 focus:ring-primary rounded-sm p-1"
            >
              <span aria-hidden="true" className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="flex flex-col">
              <span className="font-headline font-extrabold text-verde tracking-tight text-xs uppercase opacity-60">MicoPay</span>
              <h1 className="font-headline font-bold text-xl text-tinta">{t('deposit.title')}</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 pt-12 pb-24">
        <div className="flex flex-col space-y-8">
          {/* Aqui se pintaba la insignia de estado de una operacion con el estado
            fijado a mano en `pending`. Pero en esta pantalla NO EXISTE ninguna
            operacion: aun no se elige agente ni se confirma nada. Decia
            "Operacion creada · la solicitud se registro" — en pasado, afirmando
            un hecho que no habia ocurrido, dos pantallas antes de confirmar.

            La intencion era buena (principio 2 del manifiesto: la persona
            siempre sabe donde esta su dinero) pero se cumplia con una mentira.
            Se conserva la tranquilidad y se quita la afirmacion falsa. */}
          <p className="text-sm text-on-surface-variant">
            {t('deposit.nothingMovedYet')}
          </p>

          <div className="space-y-6">
            <label htmlFor="deposit-amount" className="font-medium text-[10px] tracking-wide uppercase text-on-surface-variant/70">
              {t('deposit.amountLabel')}
            </label>
            <AmountField
              id="deposit-amount"
              divisa="MXN"
              placeholder="500"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <AssetSelector
            flow="deposit"
            amountMxn={amount.trim() === '' ? null : Number(amount)}
            value={assetKey}
            onChange={onAssetChange}
          />

          <div className="bg-surface-container-lowest p-6 rounded-sm space-y-4">
            <div className="flex items-start space-x-4">
              <div className="p-3 bg-primary/10 rounded-sm">
                <span aria-hidden="true" className="material-symbols-outlined text-verde">travel_explore</span>
              </div>
              <div className="flex-1">
                <p className="text-on-surface font-medium leading-relaxed">
                  {t('deposit.info')}
                </p>
              </div>
            </div>
          </div>

          <div className="pt-8">
            <button
              onClick={() => onSearch(amount)}
              aria-label="Buscar agentes"
              className="w-full bg-naranja text-papel border-2 border-tinta shadow-solida h-[56px] rounded-sm font-headline font-bold text-lg active:translate-x-[2px] active:translate-y-[2px] transition-all duration-200 flex items-center justify-center space-x-2 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <span>{t('deposit.search')}</span>
              <span aria-hidden="true" className="material-symbols-outlined text-xl">chevron_right</span>
            </button>
          </div>
        </div>

        <div className="fixed -bottom-12 -right-12 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      </main>
    </div>
  );
};

export default DepositRequest;
