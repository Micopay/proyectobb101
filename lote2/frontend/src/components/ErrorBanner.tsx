import type { ApiErrorAction } from '../utils/apiError';
import SupportLink from './SupportLink';

interface ErrorBannerProps {
  message: string;
  action?: ApiErrorAction;
  onRetry?: () => void;
  onDismiss?: () => void;
  retryLabel?: string;
  supportTradeId?: string;
  supportState?: string;
  /** `banner` = inline alert; `blocking` = centered section for full-page recovery */
  variant?: 'banner' | 'blocking';
  className?: string;
}

export default function ErrorBanner({
  message,
  action = 'retry',
  onRetry,
  onDismiss,
  retryLabel = 'Reintentar',
  supportTradeId,
  supportState = 'ERROR',
  variant = 'banner',
  className = '',
}: ErrorBannerProps) {
  const showRetry = action === 'retry' && onRetry;
  const showSupport = action === 'support' || !showRetry;

  const actions = (
    <div className="flex flex-wrap items-center gap-3 justify-end">
      {showRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-semibold text-primary underline hover:no-underline"
        >
          {retryLabel}
        </button>
      ) : null}
      {showSupport ? (
        <SupportLink tradeId={supportTradeId} state={supportState} />
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs font-semibold text-gris underline hover:no-underline"
        >
          Ocultar
        </button>
      ) : null}
    </div>
  );

  if (variant === 'blocking') {
    return (
      <div
        className={`flex flex-col items-center text-center gap-4 py-12 px-6 ${className}`}
        role="alert"
        aria-live="assertive"
      >
        <div className="w-16 h-16 rounded-sm bg-error/10 flex items-center justify-center">
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-error text-3xl"
            style={{ fontVariationSettings: '"FILL" 1' }}
          >
            error
          </span>
        </div>
        <p className="text-sm font-medium text-on-surface leading-relaxed max-w-[280px]">{message}</p>
        {actions}
      </div>
    );
  }

  return (
    <div
      className={`rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 flex flex-col gap-2 ${className}`}
      role="alert"
      aria-live="assertive"
    >
      <p>{message}</p>
      {actions}
    </div>
  );
}
