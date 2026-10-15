import { useState } from "react";
import { useTranslation } from 'react-i18next';
import { readJSON, removeKey } from "../services/secureStorage";

interface DebugOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  envName: string;
  backendUrl: string;
  isDemoMode: boolean;
  isMockStellar: boolean;
  backendConnected: boolean;
  backendHealth: any;
}

export default function DebugOverlay({
  isOpen,
  onClose,
  envName,
  backendUrl,
  isDemoMode,
  isMockStellar,
  backendConnected,
  backendHealth,
}: DebugOverlayProps) {
  const { t } = useTranslation();
  const [showUsers, setShowUsers] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!isOpen) return null;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const handleResetData = async () => {
    if (confirm("¿Estás seguro de que deseas restablecer los datos locales? Se eliminarán los usuarios registrados y tokens.")) {
      await removeKey("micopay_users");
      window.location.reload();
    }
  };

  const escrowId = backendHealth?.configCheck?.hasContractId 
    ? (backendHealth?.escrowContractId || "Configurado (Verificar en backend)") 
    : "No configurado";

  const mxneId = backendHealth?.mxneContractId || "No configurado";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 animate-fade-in font-['Manrope']">
      <div className="w-full max-w-lg bg-surface rounded-t-3xl border-t border-gray-200 overflow-hidden flex flex-col max-h-[85vh] animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-primary/5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-2xl">bug_report</span>
            <div>
              <h2 className="text-base font-bold text-on-surface">Depuración Interna</h2>
              <p className="text-[10px] text-gray-500 font-mono">Build Variant: {envName}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            aria-label={t('a11y.close')}
            className="w-8 h-8 rounded-sm bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-600 transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          
          {/* Server Connection Status */}
          <div className="bg-gray-50 rounded-sm p-4 border border-gray-100 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">Conexión Backend</span>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                backendConnected ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${backendConnected ? "bg-green-500" : "bg-red-500"}`}></span>
                {backendConnected ? "Conectado" : "Desconectado"}
              </span>
            </div>
            
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-xs font-mono">
              <div className="text-gray-500">API Endpoint:</div>
              <div className="text-on-surface truncate text-right">{backendUrl}</div>
              <div className="text-gray-500">Stellar Network:</div>
              <div className="text-on-surface text-right">{backendHealth?.stellarNetwork || "N/A"}</div>
              <div className="text-gray-500">MOCK_STELLAR:</div>
              <div className="text-on-surface text-right font-semibold">
                {isMockStellar ? "ON (Simulado)" : "OFF (Soroban Real)"}
              </div>
              <div className="text-gray-500">Demo Mode:</div>
              <div className="text-on-surface text-right font-semibold">
                {isDemoMode ? "ON" : "OFF (Producción-Intent)"}
              </div>
            </div>
          </div>

          {/* Contracts & Keys */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-gray-500 px-1">Contratos Soroban & Cuentas</span>
            <div className="bg-gray-50 rounded-sm p-4 border border-gray-100 space-y-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500">
                  <span>Escrow Contract ID</span>
                  <button 
                    onClick={() => copyToClipboard(escrowId, "escrow")}
                    className="text-primary hover:underline text-[10px]"
                  >
                    {copiedKey === "escrow" ? "Copiado" : "Copiar"}
                  </button>
                </div>
                <div className="text-xs font-mono bg-papel p-2 rounded-sm border border-gray-100 break-all select-all text-on-surface">
                  {escrowId}
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] font-semibold text-gray-500">
                  <span>MXNE Contract ID</span>
                  <button 
                    onClick={() => copyToClipboard(mxneId, "mxne")}
                    className="text-primary hover:underline text-[10px]"
                  >
                    {copiedKey === "mxne" ? "Copiado" : "Copiar"}
                  </button>
                </div>
                <div className="text-xs font-mono bg-papel p-2 rounded-sm border border-gray-100 break-all select-all text-on-surface">
                  {mxneId}
                </div>
              </div>
            </div>
          </div>

          {/* Developer Tools */}
          <div className="space-y-2">
            <span className="text-xs font-semibold text-gray-500 px-1">Herramientas de Desarrollador</span>
            <div className="bg-gray-50 rounded-sm p-4 border border-gray-100 space-y-3">
              <button 
                onClick={handleResetData}
                className="w-full py-2.5 px-4 bg-red-50 hover:bg-red-100 text-red-700 rounded-sm text-xs font-semibold transition-colors flex items-center justify-center gap-1 border border-red-200"
              >
                <span className="material-symbols-outlined text-sm">delete_forever</span>
                Restablecer Usuarios Locales (Limpiar Caché)
              </button>
              
              <button 
                onClick={() => setShowUsers(!showUsers)}
                className="w-full py-2.5 px-4 bg-papel hover:bg-gray-100 text-gray-700 rounded-sm text-xs font-semibold transition-colors flex items-center justify-center gap-1 border border-gray-200"
              >
                <span className="material-symbols-outlined text-sm">people</span>
                {showUsers ? "Ocultar Detalles de Sesión" : "Ver Detalles de Sesión"}
              </button>

              {showUsers && (
                <div className="p-3 bg-papel border border-gray-200 rounded-sm space-y-2">
                  <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Identidad de Comprador</div>
                  <div className="text-[11px] font-mono break-all text-on-surface">
                    <strong>ID:</strong> {backendHealth?.buyerUser?.id || "Generado dinámicamente en cliente"}
                  </div>
                  <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mt-2">Identidad de Comercio</div>
                  <div className="text-[11px] font-mono break-all text-on-surface">
                    <strong>ID:</strong> {backendHealth?.sellerUser?.id || "Generado dinámicamente en cliente"}
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-[11px] text-gray-500 font-mono">
          <span>Stellar SDK: v14.6</span>
          <span>Vite: v6.2</span>
        </div>
      </div>
    </div>
  );
}
