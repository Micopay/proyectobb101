import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ShieldAlert,
  ShieldCheck,
  Clock,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  ExternalLink,
  AlertTriangle,
  Lock,
  Building2,
} from 'lucide-react';
import {
  SignatureRequest,
  getSignatureRequest,
  resolveSignatureRequest,
} from '../services/signRequestService';
import {
  decodeTransactionXdr,
  DecodedTransaction,
} from '../services/transactionDecoder';

interface SignatureApprovalProps {
  requestId?: string;
  initialRequest?: SignatureRequest;
  token?: string;
  onBack?: () => void;
  onResolved?: (status: 'approved' | 'rejected') => void;
}

export const SignatureApproval: React.FC<SignatureApprovalProps> = ({
  requestId,
  initialRequest,
  token,
  onBack,
  onResolved,
}) => {
  const { t } = useTranslation();
  const [request, setRequest] = useState<SignatureRequest | null>(initialRequest ?? null);
  const [loading, setLoading] = useState<boolean>(!initialRequest && !!requestId);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvedStatus, setResolvedStatus] = useState<'approved' | 'rejected' | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  // Load signature request if ID is provided
  useEffect(() => {
    if (!requestId || initialRequest) return;
    let isMounted = true;
    setLoading(true);
    setFetchError(null);

    getSignatureRequest(requestId, token)
      .then((data) => {
        if (isMounted) {
          setRequest(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setFetchError(err.message || t('signatureApproval.errors.fetchFailed'));
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [requestId, initialRequest, token, t]);

  // Expiry countdown timer
  useEffect(() => {
    if (!request?.expires_at) return;

    const updateTimer = () => {
      const expires = new Date(request.expires_at).getTime();
      const now = new Date().getTime();
      const diff = Math.max(0, Math.floor((expires - now) / 1000));
      setTimeLeft(diff);
      if (diff === 0 && request.status === 'pending') {
        setRequest((prev) => (prev ? { ...prev, status: 'expired' } : null));
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [request?.expires_at, request?.status]);

  // Decode XDR
  const decoded: DecodedTransaction | null = request?.xdr
    ? decodeTransactionXdr(request.xdr, request.network_passphrase)
    : null;

  const isExpired = request?.status === 'expired' || timeLeft === 0;
  const isPending = request?.status === 'pending' && !isExpired && !resolvedStatus;

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleApprove = async () => {
    if (!request || !isPending || actionLoading) return;
    setActionLoading(true);
    setActionError(null);

    try {
      await resolveSignatureRequest(
        request.id,
        'approve',
        request.xdr,
        request.network_passphrase,
        token
      );
      setResolvedStatus('approved');
      if (onResolved) onResolved('approved');
    } catch (err: any) {
      setActionError(err.message || t('signatureApproval.errors.approveFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!request || actionLoading) return;
    setActionLoading(true);
    setActionError(null);

    try {
      await resolveSignatureRequest(
        request.id,
        'reject',
        undefined,
        undefined,
        token
      );
      setResolvedStatus('rejected');
      if (onResolved) onResolved('rejected');
    } catch (err: any) {
      setActionError(err.message || t('signatureApproval.errors.rejectFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F4FAFF] flex flex-col items-center justify-center p-4">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mb-4" />
        <p className="text-gray-600 text-sm font-medium">
          {t('signatureApproval.loading')}
        </p>
      </div>
    );
  }

  if (fetchError || !request) {
    return (
      <div className="min-h-screen bg-[#F4FAFF] flex flex-col p-4">
        <header className="flex items-center mb-6">
          <button aria-label={t('a11y.back')}
            onClick={onBack}
            className="p-2 rounded-full hover:bg-gray-200 transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-gray-700" />
          </button>
          <h1 className="text-lg font-bold text-gray-900 ml-2">
            {t('signatureApproval.title')}
          </h1>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
          <AlertTriangle className="w-12 h-12 text-amber-500 mb-3" />
          <h2 className="text-xl font-bold text-gray-900 mb-2">
            {t('signatureApproval.errorTitle')}
          </h2>
          <p className="text-sm text-gray-600 mb-6">
            {fetchError || t('signatureApproval.notFound')}
          </p>
          <button
            onClick={onBack}
            className="w-full max-w-xs py-3 bg-gray-900 text-white rounded-xl font-medium"
          >
            {t('signatureApproval.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4FAFF] flex flex-col justify-between p-4 max-w-md mx-auto">
      {/* Top Header */}
      <div>
        <header className="flex items-center justify-between mb-4">
          <button aria-label={t('a11y.back')}
            onClick={onBack}
            className="p-2 rounded-full hover:bg-gray-200 transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-gray-700" />
          </button>
          <div className="flex items-center space-x-1.5 bg-amber-100 text-amber-900 px-3 py-1 rounded-full text-xs font-semibold">
            <ShieldAlert className="w-4 h-4 text-amber-700" />
            <span>{t('signatureApproval.securityBoundaryBadge')}</span>
          </div>
        </header>

        {/* Security Warning Banner */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 mb-5 text-amber-900 flex items-start space-x-3">
          <Building2 className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <p className="font-bold mb-0.5">
              {t('signatureApproval.externalRequestHeader')}
            </p>
            <p>
              {t('signatureApproval.externalRequestDesc', {
                appName: request.app_name,
              })}
            </p>
          </div>
        </div>

        {/* Request Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
            <div className="flex items-center space-x-3">
              {request.app_icon ? (
                <img
                  src={request.app_icon}
                  alt={request.app_name}
                  className="w-10 h-10 rounded-full border border-gray-200 object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg border border-blue-100">
                  {request.app_name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="font-bold text-gray-900 text-base">
                  {request.app_name}
                </h3>
                <p className="text-xs text-gray-500">
                  {t('signatureApproval.requestSourceLabel')}
                </p>
              </div>
            </div>

            {/* Countdown / Status badge */}
            {isPending && (
              <div className="flex items-center space-x-1 text-xs font-semibold text-gray-600 bg-gray-100 px-2.5 py-1 rounded-lg">
                <Clock className="w-3.5 h-3.5 text-gray-500" />
                <span>{formatCountdown(timeLeft)}</span>
              </div>
            )}

            {(isExpired || request.status === 'expired') && (
              <span className="text-xs font-semibold text-red-700 bg-red-100 px-2.5 py-1 rounded-lg">
                {t('signatureApproval.statusExpired')}
              </span>
            )}
          </div>

          {/* Decoded Effect Section */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
              {t('signatureApproval.transactionEffectTitle')}
            </h4>

            {decoded?.type === 'payment' && (
              <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 text-center">
                <p className="text-xs text-gray-500 mb-1">
                  {t('signatureApproval.youWillSend')}
                </p>
                <div className="text-3xl font-extrabold text-gray-900 mb-2">
                  {decoded.amount}{' '}
                  <span className="text-primary">{decoded.assetCode}</span>
                </div>
                <div className="text-xs text-gray-600 font-mono break-all bg-white p-2 rounded-lg border border-gray-200 mt-2">
                  <span className="text-gray-400 font-sans block mb-0.5">
                    {t('signatureApproval.destinationLabel')}:
                  </span>
                  {decoded.destination}
                </div>
                {decoded.memo && (
                  <p className="text-xs text-gray-500 mt-2">
                    <span className="font-medium">{t('signatureApproval.memoLabel')}:</span>{' '}
                    {decoded.memo}
                  </p>
                )}
              </div>
            )}

            {(decoded?.type === 'unsupported' || decoded?.type === 'unknown') && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-left">
                <div className="flex items-center space-x-2 text-red-800 font-bold text-sm mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                  <span>{t('signatureApproval.warnings.untrustedTitle')}</span>
                </div>
                <p className="text-xs text-red-700 leading-relaxed mb-3">
                  {t(decoded.warningKey)}
                </p>
                <div className="bg-white/80 p-2.5 rounded-lg border border-red-200 text-xs font-mono text-gray-700 break-all max-h-24 overflow-y-auto">
                  {request.xdr}
                </div>
              </div>
            )}

            {/* Local Security Assurance */}
            <div className="flex items-center space-x-2 text-[11px] text-gray-500 pt-2 border-t border-gray-100">
              <Lock className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
              <span>{t('signatureApproval.localSigningAssurance')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Action Errors */}
      {actionError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-xl mb-4">
          {actionError}
        </div>
      )}

      {/* Resolved Confirmation overlay / message */}
      {resolvedStatus ? (
        <div className="bg-white rounded-2xl p-5 border border-gray-100 text-center shadow-sm">
          {resolvedStatus === 'approved' ? (
            <>
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-2" />
              <h3 className="font-bold text-gray-900 text-base mb-1">
                {t('signatureApproval.approvedSuccessTitle')}
              </h3>
              <p className="text-xs text-gray-500 mb-4">
                {t('signatureApproval.approvedSuccessDesc')}
              </p>
            </>
          ) : (
            <>
              <XCircle className="w-12 h-12 text-gray-400 mx-auto mb-2" />
              <h3 className="font-bold text-gray-900 text-base mb-1">
                {t('signatureApproval.rejectedSuccessTitle')}
              </h3>
              <p className="text-xs text-gray-500 mb-4">
                {t('signatureApproval.rejectedSuccessDesc')}
              </p>
            </>
          )}
          <button
            onClick={onBack}
            className="w-full py-3 bg-gray-900 text-white rounded-xl font-medium text-sm"
          >
            {t('signatureApproval.back')}
          </button>
        </div>
      ) : (
        /* Action buttons */
        <div className="space-y-2 pt-2">
          {isPending ? (
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={handleReject}
                disabled={actionLoading}
                className="w-full py-3.5 border border-gray-300 text-gray-700 rounded-xl font-semibold text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                {t('signatureApproval.rejectBtn')}
              </button>
              <button
                onClick={handleApprove}
                disabled={actionLoading || decoded?.type === 'unknown' || decoded?.type === 'unsupported'}
                className="w-full py-3.5 bg-primary text-white rounded-xl font-semibold text-sm shadow-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
              >
                {actionLoading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                ) : (
                  <span>{t('signatureApproval.approveBtn')}</span>
                )}
              </button>
            </div>
          ) : (
            <button
              onClick={handleReject}
              disabled={actionLoading}
              className="w-full py-3.5 bg-gray-200 text-gray-800 rounded-xl font-semibold text-sm hover:bg-gray-300 transition-colors"
            >
              {t('signatureApproval.dismissExpiredBtn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
