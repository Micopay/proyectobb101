import { Component, ReactNode } from 'react';
import SupportLink from './SupportLink';
import { resolveErrorMessage } from '../constants/errorMap';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  supportCode: string;
}

/** Generate a short hex support code the user can quote to support. */
function generateSupportCode(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, supportCode: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, supportCode: generateSupportCode() };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', {
      error_code: 'RENDER_CRASH',
      message: error.message,
      stack: error.stack,
      context: { support_code: this.state.supportCode },
    });
  }

  render() {
    if (this.state.hasError) {
      const resolved = resolveErrorMessage(this.state.error ?? undefined);
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-container-lowest px-6">
          <div className="text-center max-w-sm">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="font-headline font-bold text-xl text-on-surface mb-2">{resolved.title}</h2>
            <p className="text-sm text-on-surface-variant mb-2">{resolved.message}</p>
            <p className="text-xs text-on-surface-variant/70 mb-2">
              {resolved.fundsSafe ? 'Tus fondos están seguros.' : 'Revisa el estado de tus fondos antes de seguir.'}
            </p>
            <p className="text-xs text-on-surface-variant/70 mb-2">{resolved.action}</p>
            {this.state.error && (
              <p className="text-xs text-on-surface-variant/60 font-mono mb-4 break-all">
                {this.state.error.message}
              </p>
            )}
            {this.state.supportCode && (
              <p className="text-xs text-on-surface-variant mb-6">
                Código de soporte:{' '}
                <span className="font-mono font-bold text-on-surface">
                  {this.state.supportCode}
                </span>
              </p>
            )}
            <div className="flex flex-col gap-3 items-center">
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-3 rounded-sm bg-primary text-on-primary font-bold text-sm active:translate-x-[2px] active:translate-y-[2px] transition-transform"
              >
                Reintentar
              </button>
              <SupportLink state="ERROR" />
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;