interface ErrorEntry {
  title: string;
  message: string;
  action: string;
  fundsSafe: boolean;
}

export declare const errorMessages: {
  network: { offline: ErrorEntry; unavailable: ErrorEntry; timeout: ErrorEntry };
  auth: { invalidCredentials: ErrorEntry; sessionExpired: ErrorEntry; unauthorized: ErrorEntry };
  financial: { conflict: ErrorEntry; insufficientFunds: ErrorEntry; failed: ErrorEntry; cancelled: ErrorEntry };
  escrow: { unavailable: ErrorEntry; releasePending: ErrorEntry };
  qr: { invalid: ErrorEntry; cameraDenied: ErrorEntry; scanFailed: ErrorEntry; expired: ErrorEntry; unreadable: ErrorEntry };
  dispute: { pending: ErrorEntry; resolved: ErrorEntry };
  refund: { pending: ErrorEntry; failed: ErrorEntry };
  generic: { fallback: ErrorEntry };
};
