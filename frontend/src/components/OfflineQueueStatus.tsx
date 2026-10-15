/**
 * Offline Queue Status Indicator
 * 
 * Displays the current state of the offline queue to the user
 */

import { useTranslation } from 'react-i18next';
import { useOfflineQueue } from '../hooks/useOfflineQueue';

interface OfflineQueueStatusProps {
  token: string | null;
  compact?: boolean;
}

export default function OfflineQueueStatus({
  token,
  compact = false,
}: OfflineQueueStatusProps) {
  const { t } = useTranslation();
  const offlineQueue = useOfflineQueue(token);

  // Don't show anything if online and no pending items
  if (offlineQueue.isOnline && !offlineQueue.hasPending) {
    return null;
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-700">
        {!offlineQueue.isOnline ? (
          <>
            <span className="material-symbols-outlined text-sm">wifi_off</span>
            {t('offlineQueue.compactOffline')}
          </>
        ) : offlineQueue.hasPending ? (
          <>
            <span className="material-symbols-outlined text-sm">pending</span>
            {t('offlineQueue.compactPending')}
          </>
        ) : null}
      </div>
    );
  }

  // Full version with more details
  if (!offlineQueue.isOnline) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-sm p-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-amber-600 text-xl">wifi_off</span>
          <div className="flex-1">
            <h4 className="font-semibold text-amber-900">{t('offlineQueue.offlineTitle')}</h4>
            <p className="text-sm text-amber-700">
              {t('offlineQueue.offlineBody')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (offlineQueue.hasPending) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-sm p-4">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-blue-600 text-xl animate-spin">
            progress_activity
          </span>
          <div className="flex-1">
            <h4 className="font-semibold text-blue-900">{t('offlineQueue.pendingTitle')}</h4>
            <p className="text-sm text-blue-700">
              {t('offlineQueue.pendingBody')}
            </p>
          </div>
          <button
            onClick={() => offlineQueue.retryAsync(token)}
            className="ml-auto px-3 py-1 bg-blue-600 text-papel rounded text-sm font-medium hover:bg-blue-700"
          >
            {t('offlineQueue.retry')}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
