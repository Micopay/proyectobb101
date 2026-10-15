/**
 * Merchant Availability Toggle Component
 * 
 * Provides a UI component for toggling merchant availability with offline support
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateMerchantAvailabilityWithOfflineSupport } from '../services/api';
import { useOfflineQueue } from '../hooks/useOfflineQueue';

interface MerchantAvailabilityToggleProps {
  token: string | null;
  initialAvailable: boolean;
  onAvailabilityChange?: (available: boolean) => void;
  disabled?: boolean;
  /**
   * Whether the merchant already has a location set (from `getMerchantConfig().latitude`).
   * Optional and soft: when omitted, the no-location warning is simply skipped — this
   * component does not fetch merchant config itself. Does NOT block activation either way
   * (decision: minimal friction, see docs/PLAN_MAPA_REAL_2026-07.md WP2).
   */
  hasLocation?: boolean;
}

export default function MerchantAvailabilityToggle({
  token,
  initialAvailable,
  onAvailabilityChange,
  disabled = false,
  hasLocation,
}: MerchantAvailabilityToggleProps) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(initialAvailable);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offlineQueue = useOfflineQueue(token);

  const handleToggle = async () => {
    if (!token || loading) return;

    const newState = !available;
    setLoading(true);
    setError(null);

    try {
      const result = await updateMerchantAvailabilityWithOfflineSupport(
        token,
        newState,
        offlineQueue.queueMutationAsync,
      );

      setAvailable(newState);
      onAvailabilityChange?.(newState);

      if (result.queued) {
        console.log('✅ Availability change queued for sync');
      }
    } catch (err: any) {
      console.error('Error updating availability:', err);
      setError(err?.message || 'Failed to update availability');
      // Revert the state on error
      setAvailable(!newState);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleToggle}
        disabled={disabled || loading || !token}
        className={`
          relative inline-flex items-center h-8 rounded-sm transition-colors
          ${available ? 'bg-green-500' : 'bg-gray-300'}
          ${disabled || loading || !token ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}
        `}
        style={{ width: '48px' }}
      >
        <span
          className={`
            inline-block h-6 w-6 rounded-full bg-papel transform transition-transform
            ${available ? 'translate-x-5' : 'translate-x-1'}
          `}
        />
        <span className="sr-only">
          {available ? 'Disponible' : 'No disponible'}
        </span>
      </button>

      {error && (
        <p className="text-sm text-red-600">
          ⚠️ {error}
        </p>
      )}

      {available && hasLocation === false && (
        <p className="text-xs text-amber-600">
          ⚠️ {t('merchantSettings.location.noLocationWarning')}
        </p>
      )}

      {offlineQueue.hasPending && (
        <p className="text-xs text-amber-600">
          ⏳ {available ? 'Cambio a disponible' : 'Cambio a no disponible'} pendiente de sincronizar
        </p>
      )}

      {offlineQueue.isSyncing && (
        <p className="text-xs text-blue-600 flex items-center gap-1">
          <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
          Sincronizando cambio...
        </p>
      )}
    </div>
  );
}
