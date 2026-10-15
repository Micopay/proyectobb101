import i18n from '../i18n';

const KNOWN_PATHS = [
  'network.offline', 'network.unavailable', 'network.timeout',
  'auth.invalidCredentials', 'auth.sessionExpired', 'auth.unauthorized',
  'financial.conflict', 'financial.insufficientFunds', 'financial.failed', 'financial.cancelled',
  'escrow.unavailable', 'escrow.releasePending',
  'qr.invalid', 'qr.cameraDenied', 'qr.scanFailed', 'qr.expired', 'qr.unreadable',
  'dispute.pending', 'dispute.resolved',
  'refund.pending', 'refund.failed',
  'generic.fallback',
];

/** Builds a { path: message } lookup, resolved fresh against the current i18n language. */
function buildErrorMessages() {
  const entries = KNOWN_PATHS.map((path) => {
    const [group, key] = path.split('.');
    const message = {
      title: i18n.t(`errors.${path}.title`),
      message: i18n.t(`errors.${path}.message`),
      action: i18n.t(`errors.${path}.action`),
      fundsSafe: true,
    };
    return [group, key, message];
  });

  const grouped = {};
  for (const [group, key, message] of entries) {
    grouped[group] = grouped[group] || {};
    grouped[group][key] = message;
  }
  return grouped;
}

// A live getter (not a static object) so every lookup reflects the current
// language — errorMap.js's getByKey() calls this on each resolveErrorMessage().
export const errorMessages = new Proxy(
  {},
  {
    get(_target, group) {
      return buildErrorMessages()[group];
    },
  },
);
