import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import DeleteAccountModal from "../components/DeleteAccountModal";
import SecretKeyBackupModal from "../components/SecretKeyBackupModal";
import { revealSecretKey, importKeypair } from '../lib/keystore';
import {
  deleteAccount,
  getCurrentUser,
  getAuthToken,
  type CurrentUserProfile,
} from "../services/api";
import { setLanguage } from "../i18n";

/** Deterministic avatar gradient seeded by the Stellar address (no external images). */
const TIER_STYLE: Record<string, { bg: string; text: string; icon: string }> = {
  Oro: { bg: "#FFF6DB", text: "#9A7B12", icon: "workspace_premium" },
  Plata: { bg: "#EEF1F4", text: "#5A6B78", icon: "military_tech" },
  Bronce: { bg: "#F6E8DE", text: "#9A5B2E", icon: "verified" },
  Nuevo: { bg: "#E1F5EE", text: "#00694C", icon: "spa" },
};

interface ProfileProps {
  token: string | null;
  username?: string | null;
  devicePublicKey?: string | null;
  onBack: () => void;
  onDeleted: () => void;
  onLogout: () => void;
  onNavigatePrivacy?: () => void;
  onNavigateTerms?: () => void;
  /** RED-2: entrada al alta como agente de Red MicoPay. */
  onNavigateJoinNetwork?: () => void;
  /** Pertenencia real, leida del servidor. No se infiere de tener sesion. */
  providerStatus?: 'not_enrolled' | 'pending_verification' | 'active' | 'suspended' | null;
  /** Disponibilidad actual; solo significa algo si eres agente activo. */
  availability?: string | null;
  /** Cambia la disponibilidad. Solo se ofrece a agentes activos. */
  onToggleAvailability?: (next: 'online' | 'paused') => void;
  onToggleDebug?: () => void;
}

const Profile = ({ token, username, devicePublicKey, onBack, onDeleted, onLogout, onNavigatePrivacy, onNavigateTerms, onNavigateJoinNetwork, providerStatus, availability, onToggleAvailability }: ProfileProps) => {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState<CurrentUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedAddress, setImportedAddress] = useState<string | null>(null);
  const [activeToken, setActiveToken] = useState<string | null>(token);

  // Keep activeToken in sync with token prop (e.g., after parent refreshes session)
  useEffect(() => {
    if (token) setActiveToken(token);
  }, [token]);

  useEffect(() => {
    let cancelled = false;

    const load = async (tkn: string) => {
      try {
        setLoading(true);
        setError(null);
        const currentUser = await getCurrentUser(tkn);
        if (!cancelled) setProfile(currentUser);
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        // 401 / 403 → try to get a fresh token with device keypair
        if ((status === 401 || status === 403) && username) {
          try {
            const fresh = await getAuthToken();
            setActiveToken(fresh);
            const currentUser = await getCurrentUser(fresh);
            if (!cancelled) setProfile(currentUser);
          } catch {
            if (!cancelled) setError('Tu sesión expiró. Vuelve a iniciar sesión.');
          }
        } else {
          setError(err?.response?.data?.message ?? 'No se pudo cargar el perfil. Revisa tu conexión.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (activeToken) {
      load(activeToken);
    } else if (username) {
      // No token at all → try to get one with device keypair
      setLoading(true);
      getAuthToken()
        .then((fresh) => {
          if (!cancelled) {
            setActiveToken(fresh);
            return load(fresh);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoading(false);
            setError('Tu sesión expiró. Vuelve a iniciar sesión.');
          }
        });
    } else {
      setLoading(false);
      setError('Tu sesión expiró. Vuelve a iniciar sesión.');
    }

    return () => { cancelled = true; };
  }, [activeToken, username]);


  const openDeleteModal = () => {
    setConfirmation("");
    setError(null);
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setShowDeleteModal(false);
    setConfirmation("");
    setError(null);
  };

  const handleDelete = async () => {
    if (!activeToken || !profile || confirmation.trim() !== profile.username) {
      return;
    }

    try {
      setDeleting(true);
      setError(null);
      await deleteAccount(activeToken, profile.username);
      setSuccess(true);
      setShowDeleteModal(false);
      setTimeout(() => {
        onDeleted();
      }, 800);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'No se pudo eliminar la cuenta.');
    } finally {
      setDeleting(false);
    }
  };

  const handleCopyAddress = () => {
    if (devicePublicKey) navigator.clipboard.writeText(devicePublicKey);
  };

  // La llave ya no pasa por el portapapeles: se revela en un modal con
  // FLAG_SECURE activo (ISSUE-03 / SEC-33). Aquí no se exige transcripción
  // porque el usuario puede estar solo consultándola, no respaldando por
  // primera vez; el respaldo obligatorio se hace en el alta.
  const handleExport = async () => {
    setExportError(null);
    try {
      const secret = await revealSecretKey();
      setRevealedSecret(secret);
    } catch {
      setExportError('No se pudo leer tu llave. Cierra la app y vuelve a intentarlo.');
    }
  };

  const handleImport = async () => {
    setImportError(null);
    try {
      const newPub = await importKeypair(importInput.trim());
      setImportedAddress(newPub);
      setShowImportModal(false);
      setImportInput('');
    } catch {
      setImportError('Llave inválida. Las llaves secretas de Stellar empiezan con "S" y tienen 56 caracteres.');
    }
  };

  return (
      <div className="bg-fondo text-tinta min-h-screen flex flex-col pb-28">
        <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta/60">
          <button aria-label={t('a11y.back')}
              onClick={onBack}
              className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-[#EFF6FA] transition-colors"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 className="font-bold text-lg leading-tight">{t('profile.title')}</h1>
            <p className="text-[11px] text-gris">
              {t('profile.subtitle')}
            </p>
          </div>
        </header>

        <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-4 pt-4 space-y-5">
          {loading && (
              <div className="bg-papel rounded-sm p-6 border-2 border-tinta/60 text-center">
            <span className="material-symbols-outlined animate-spin text-verde text-3xl">
              progress_activity
            </span>
                <p className="mt-3 text-sm text-gris">{t('profile.loadingProfile')}</p>
              </div>
          )}

          {!loading && error && (
              <div className="bg-[#FFECEF] border-2 border-tinta rounded-sm px-5 py-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-rojo text-xl mt-0.5" style={{ fontVariationSettings: '"FILL" 1' }}>error</span>
                  <p className="text-sm text-rojo font-medium leading-snug">{error}</p>
                </div>
                <button
                  onClick={onLogout}
                  className="w-full min-h-12 text-sm font-bold bg-[#C62828] text-papel rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
                >
                  Iniciar sesión de nuevo
                </button>
              </div>
          )}

          {!loading && profile && (
              <>
                <section className="bg-verde-suave rounded-sm p-5 border-2 border-tinta ">
                  <div className="flex items-center gap-4">
                    <div
                      className="w-16 h-16 rounded-sm border-2 border-tinta bg-tinta flex items-center justify-center text-papel font-extrabold text-2xl flex-shrink-0"
                    >
                      {profile.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-bold uppercase tracking-[0.15em] text-verde">
                          {t('profile.activeAccount')}
                        </p>
                        {(() => {
                          const tier = profile.reputation_tier ?? "Nuevo";
                          const s = TIER_STYLE[tier] ?? TIER_STYLE.Nuevo;
                          return (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
                              style={{ backgroundColor: s.bg, color: s.text }}
                            >
                              <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: '"FILL" 1' }}>{s.icon}</span>
                              {tier}
                            </span>
                          );
                        })()}
                      </div>
                      <h2 className="text-2xl font-extrabold text-tinta truncate">
                        @{profile.username}
                      </h2>
                      <p className="text-xs text-gris truncate font-mono">
                        {profile.stellar_address}
                      </p>
                    </div>
                  </div>

                  {/* Reputation stats */}
                  <div className="grid grid-cols-3 gap-2 mt-5">
                    <div className="bg-papel rounded-sm p-3 text-center">
                      <p className="text-xl font-extrabold text-tinta">{profile.trades_completed ?? 0}</p>
                      <p className="text-[10px] text-gris mt-0.5 leading-tight">{t('profile.ops')}</p>
                    </div>
                    <div className="bg-papel rounded-sm p-3 text-center">
                      <p className="text-xl font-extrabold text-tinta">
                        {profile.completion_rate != null ? `${profile.completion_rate}%` : '—'}
                      </p>
                      <p className="text-[10px] text-gris mt-0.5 leading-tight">{t('profile.completed')}</p>
                    </div>
                    <div className="bg-papel rounded-sm p-3 text-center">
                      <p className="text-xl font-extrabold text-tinta">
                        {profile.created_at
                          ? new Date(profile.created_at).toLocaleDateString(i18n.language === 'en' ? 'en-US' : 'es-MX', { month: 'short', year: '2-digit' })
                          : '—'}
                      </p>
                      <p className="text-[10px] text-gris mt-0.5 leading-tight">{t('profile.memberSince')}</p>
                    </div>
                  </div>
                </section>

                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris mb-2">
                      {t('profile.details')}
                    </p>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gris">
                      {t('profile.username')}
                    </span>
                        <span className="text-sm font-bold text-tinta">
                      @{profile.username}
                    </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-gris">
                      {t('profile.stellarAddress')}
                    </span>
                        <span className="text-sm font-mono text-tinta truncate max-w-[55%] text-right">
                      {profile.stellar_address}
                    </span>
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm text-gris">{t('profile.wallet')}</span>
                        <span className="text-sm font-bold text-tinta">
                      {profile.wallet_type ?? "self_custodial"}
                    </span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-3">
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris">
                    {t('profile.deviceKey')}
                  </p>
                  <p className="font-mono text-xs text-tinta break-all select-all bg-fondo rounded-sm p-3">
                    {devicePublicKey ?? t('profile.noKeyGenerated')}
                  </p>
                  <div className="flex gap-2">
                    <button
                        onClick={handleCopyAddress}
                        disabled={!devicePublicKey}
                        className="flex-1 min-h-12 text-sm font-bold border-2 border-tinta text-verde rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-40"
                    >
                      {t('profile.copyAddress')}
                    </button>
                    <button
                        onClick={() => setShowImportModal(true)}
                        className="flex-1 min-h-12 text-sm font-bold border-2 border-tinta text-gris rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
                    >
                      {t('profile.importKey')}
                    </button>
                  </div>
                  <button
                      onClick={handleExport}
                      className="w-full min-h-12 text-sm font-bold text-rojo border-2 border-tinta rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
                  >
                    {t('profile.exportKey')}
                  </button>
                </section>

                {/* Language switcher */}
                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 ">
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris mb-3">{t('profile.language')}</p>
                  <div className="flex gap-2">
                    {(['es', 'en'] as const).map((lang) => (
                      <button
                        key={lang}
                        onClick={() => setLanguage(lang)}
                        className={`flex-1 h-11 rounded-sm font-bold text-sm border transition-all active:translate-x-[2px] active:translate-y-[2px] ${
                          i18n.language === lang
                            ? 'bg-verde text-papel border-transparent'
                            : 'bg-papel text-gris border-linea'
                        }`}
                      >
                        {lang === 'es' ? '🇲🇽 Español' : '🇺🇸 English'}
                      </button>
                    ))}
                  </div>
                </section>

                {/* RED-2: Red MicoPay. La tarjeta cambia segun la pertenencia REAL,
                    no segun haya sesion. Quien no es agente ve una invitacion;
                    quien lo es, su interruptor de disponibilidad. */}
                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60">
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris mb-3">Red MicoPay</p>

                  {(providerStatus == null || providerStatus === 'not_enrolled') && (
                    <>
                      <p className="text-sm text-tinta mb-1 font-bold">Gana dando efectivo</p>
                      <p className="text-sm text-gris mb-4">
                        Entrega efectivo a quien lo necesita cerca de ti y cobra tu comisión. No
                        necesitas tener un negocio.
                      </p>
                      <button
                        onClick={onNavigateJoinNetwork}
                        className="w-full min-h-12 bg-verde text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
                      >
                        Únete a Red MicoPay
                      </button>
                    </>
                  )}

                  {providerStatus === 'pending_verification' && (
                    <>
                      <p className="text-sm text-tinta mb-1 font-bold">Alta a medias</p>
                      <p className="text-sm text-gris mb-4">
                        Te faltan pasos para activarte como agente.
                      </p>
                      <button
                        onClick={onNavigateJoinNetwork}
                        className="w-full min-h-12 border-2 border-verde text-verde font-bold rounded-sm"
                      >
                        Continuar mi alta
                      </button>
                    </>
                  )}

                  {providerStatus === 'active' && (
                    <>
                      <p className="text-sm text-tinta mb-1 font-bold">Eres agente</p>
                      <p className="text-sm text-gris mb-4">
                        {availability === 'online'
                          ? 'Apareces en el mapa y puedes recibir solicitudes.'
                          : 'Estás en pausa: sigues siendo agente, pero no apareces en el mapa.'}
                      </p>
                      <button
                        onClick={() =>
                          onToggleAvailability?.(availability === 'online' ? 'paused' : 'online')
                        }
                        className={`w-full min-h-12 font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all ${
                          availability === 'online'
                            ? 'border-2 border-tinta text-tinta'
                            : 'bg-verde text-papel'
                        }`}
                      >
                        {availability === 'online' ? 'Ponerme en pausa' : 'Ponerme disponible'}
                      </button>
                    </>
                  )}

                  {providerStatus === 'suspended' && (
                    <p className="text-sm text-gris">
                      Tu cuenta de agente está suspendida. Escríbenos para revisarlo.
                    </p>
                  )}
                </section>

                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 ">
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris mb-3">{t('profile.legal')}</p>
                  <div className="space-y-1">
                    <button
                        onClick={onNavigatePrivacy}
                        className="w-full flex items-center justify-between py-2.5 text-sm text-tinta hover:text-verde transition-colors"
                    >
                      <span>{t('profile.privacy')}</span>
                      <span aria-hidden="true" className="material-symbols-outlined text-base text-gris">chevron_right</span>
                    </button>
                    <div className="border-t border-linea/40" />
                    <button
                        onClick={onNavigateTerms}
                        className="w-full flex items-center justify-between py-2.5 text-sm text-tinta hover:text-verde transition-colors"
                    >
                      <span>{t('profile.terms')}</span>
                      <span aria-hidden="true" className="material-symbols-outlined text-base text-gris">chevron_right</span>
                    </button>
                  </div>
                </section>

                <section className="bg-papel rounded-sm p-5 border-2 border-tinta space-y-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-rojo mb-2">
                      {t('profile.dangerZone')}
                    </p>
                    <h3 className="text-xl font-bold text-tinta mb-2">
                      {t('profile.deleteTitle')}
                    </h3>
                    <p className="text-sm text-gris leading-relaxed">
                      {t('profile.deleteDesc')}
                    </p>
                  </div>

                  <div className="bg-[#FFECEF] rounded-sm p-4 border-2 border-tinta">
                    <p className="text-sm text-rojo font-medium">
                      {t('profile.deleteWarning')}
                    </p>
                  </div>

                  <button
                      type="button"
                      onClick={openDeleteModal}
                      className="w-full bg-[#C62828] text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 /20 transition-all active:translate-x-[2px] active:translate-y-[2px]"
                  >
                <span aria-hidden="true" className="material-symbols-outlined text-lg">
                  delete_forever
                </span>
                    {t('profile.deleteBtn')}
                  </button>
                </section>

                <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 ">
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gris mb-3">{t('profile.session')}</p>
                  <button
                      type="button"
                      onClick={onLogout}
                      className="w-full bg-gray-200 text-gray-800 font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[2px] active:translate-y-[2px]"
                  >
                <span aria-hidden="true" className="material-symbols-outlined text-lg">
                  logout
                </span>
                    {t('profile.logout')}
                  </button>
                </section>
              </>
          )}

          {!loading && !profile && !error && (
              <div className="bg-papel rounded-sm p-6 border-2 border-tinta/60 text-center">
            <span className="material-symbols-outlined text-gris text-3xl">
              person_off
            </span>
                <p className="mt-3 text-sm text-gris">
                  {t('profile.noProfile')}
                </p>
              </div>
          )}
        </main>

        {showDeleteModal && profile && (
            <DeleteAccountModal
                username={profile.username}
                confirmation={confirmation}
                onConfirmationChange={setConfirmation}
                onCancel={closeDeleteModal}
                onConfirm={handleDelete}
                loading={deleting}
                error={error}
            />
        )}

        {showImportModal && (
            <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-4">
              <div className="w-full bg-papel rounded-sm p-6 space-y-4 ">
                <h3 className="text-lg font-bold text-tinta">{t('profile.importKeyTitle')}</h3>
                <p className="text-sm text-gris">
                  {t('profile.importKeyDesc')}
                </p>
                <textarea
                    value={importInput}
                    onChange={e => { setImportInput(e.target.value); setImportError(null); }}
                    placeholder={t('profile.importPlaceholder')}
                    rows={3}
                    className="w-full font-mono text-xs border-2 border-tinta rounded-sm p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#00694C]"
                />
                {importError && (
                    <p className="text-xs text-red-600" role="alert">{importError}</p>
                )}
                <div className="flex gap-3">
                  <button
                      onClick={() => { setShowImportModal(false); setImportInput(''); }}
                      className="flex-1 h-12 font-bold border-2 border-tinta text-gris rounded-sm"
                  >
                    {t('profile.importCancel')}
                  </button>
                  <button
                      onClick={handleImport}
                      disabled={!importInput.trim()}
                      className="flex-1 h-12 font-bold bg-verde text-papel rounded-sm disabled:opacity-40"
                  >
                    {t('profile.importConfirm')}
                  </button>
                </div>
              </div>
            </div>
        )}

        {revealedSecret && (
            <SecretKeyBackupModal
                secretKey={revealedSecret}
                requireConfirmation={false}
                onClose={() => setRevealedSecret(null)}
            />
        )}

        {exportError && (
            <div className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-sm bg-red-50 border border-red-200 px-4 py-3 shadow-lg">
              <p className="text-sm text-red-700 font-medium" role="alert">{exportError}</p>
            </div>
        )}

        {importedAddress && (
            <div className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 max-w-[90vw] rounded-sm bg-[#E6F9F1] border border-[#1D9E75]/20 px-4 py-3 shadow-lg">
              <p className="text-sm text-[#1D9E75] font-medium">Llave importada</p>
              <p className="text-[11px] font-mono text-[#1D9E75] break-all mt-1">{importedAddress}</p>
              <button
                  onClick={() => setImportedAddress(null)}
                  className="text-[11px] text-[#1D9E75] underline mt-1"
              >
                Cerrar
              </button>
            </div>
        )}

        {success && (
            <div className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-sm bg-[#E6F9F1] border-2 border-tinta px-4 py-3 ">
              <p className="text-sm text-verde-claro font-medium">
                {t('profile.accountDeleted')}
              </p>
            </div>
        )}
      </div>
  );
};

export default Profile;