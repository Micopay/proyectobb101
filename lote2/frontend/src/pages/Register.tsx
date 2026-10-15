import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { registerUser, getAuthToken, getCurrentUser, UserData } from '../services/api';
import { generateAndStoreKeypair, getPublicKey, revealSecretKey, keypairExists } from '../lib/keystore';
import { setBackupConfirmed, writeJSON } from '../services/secureStorage';
import { ApiError } from '../utils/apiError';
import { hashPhone } from '../lib/phoneHash';
import SecretKeyBackupModal from '../components/SecretKeyBackupModal';

interface RegisterProps {
  onLoginSuccess?: (user: UserData, seller: UserData | null) => void;
}

export default function Register({ onLoginSuccess }: RegisterProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** El backend respondió que esta dirección ya tiene cuenta (ADDRESS_ALREADY_REGISTERED). */
  const [deviceHasAccount, setDeviceHasAccount] = useState(false);

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [pubKey, setPubKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [copiedPub, setCopiedPub] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState<UserData | null>(null);

  const handleRegister = async () => {
    if (!username.trim() || username.length < 3) {
      setError('El nombre de usuario debe tener al menos 3 caracteres.');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setError('Solo letras, números y guiones bajos.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Only generate a keypair if none exists — never overwrite an existing identity.
      if (!await keypairExists()) {
        await generateAndStoreKeypair();
      }
      const pub = await getPublicKey();
      const sec = await revealSecretKey();
      if (!pub || !sec) throw new Error('No se pudo generar tu identidad Stellar');

      // Hash the phone number client-side (if provided) so the raw
      // number is NEVER sent to the backend. The hash enables the
      // assertNotRelatedAccounts abuse check without exposing PII.
      const phoneHash: string | undefined = phone.trim()
        ? await hashPhone(phone.trim())
        : undefined;

      const userData = await registerUser(username.trim(), phoneHash);

      // Persist session immediately so the user is logged in after onboarding.
      await writeJSON('micopay_user', userData);
      setLoggedInUser(userData);
      setPubKey(pub);
      setSecretKey(sec);
      setShowOnboarding(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error al registrarse';
      const code = e instanceof ApiError ? e.code : undefined;
      if (code === 'ADDRESS_ALREADY_REGISTERED') {
        // Cambiar de nombre no arregla esto: la colisión es de dirección, y la
        // llave de este teléfono ya prueba que la cuenta es suya. Un toque.
        setDeviceHasAccount(true);
        setError(null);
      } else if (code === 'USERNAME_TAKEN') {
        setError('Ese nombre de usuario ya está ocupado. Elige otro.');
      } else if (msg.includes('Network') || msg.includes('fetch')) {
        setError('Sin conexión al servidor. Intenta en unos segundos.');
      } else {
        setError(`Error: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Entra a la cuenta que ya existe en este dispositivo. No pide nada más
   * porque no hace falta: el servidor identifica la cuenta por la firma de la
   * llave del teléfono, no por el nombre de usuario.
   */
  const handleUseExistingAccount = async () => {
    setError(null);
    setLoading(true);
    try {
      const token = await getAuthToken();
      const profile = await getCurrentUser(token);
      const user: UserData = { id: profile.id, username: profile.username, token };
      await writeJSON('micopay_user', user);
      onLoginSuccess?.(user, null);
      navigate('/', { replace: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'No se pudo entrar a la cuenta';
      setError(`No se pudo entrar a la cuenta de este dispositivo: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const copyPublicKey = () => {
    navigator.clipboard.writeText(pubKey);
    setCopiedPub(true);
    setTimeout(() => setCopiedPub(false), 2000);
  };

  const finishOnboarding = async () => {
    // Solo se marca como respaldada si el usuario realmente transcribió la
    // llave. Antes se marcaba siempre al pulsar "Continuar", así que una
    // cuenta sin respaldo quedaba registrada como respaldada y el modal
    // bloqueante previo a la primera operación nunca aparecía.
    if (backedUp) await setBackupConfirmed();
    if (loggedInUser && onLoginSuccess) {
      onLoginSuccess(loggedInUser, null);
      navigate('/', { replace: true });
    } else {
      navigate('/login', { replace: true });
    }
  };

  if (showOnboarding) {
    return (
      <div className="min-h-screen bg-fondo flex flex-col items-center justify-center px-6 py-12 overflow-y-auto">
        <div className="w-full max-w-md bg-papel rounded-sm p-8 space-y-6">
          <div className="text-center">
            <h1 className="font-extrabold text-2xl text-tinta">¡Tu Wallet está lista!</h1>
            <p className="text-sm text-gris mt-2">Hemos creado una billetera (wallet) no-custodial en tu dispositivo. Esto significa que solo tú tienes el control de tus fondos.</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gris uppercase tracking-wider mb-1">
                Tu Dirección Pública
              </label>
              <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-sm px-4 py-3">
                <span className="text-xs font-mono text-tinta truncate mr-2">{pubKey}</span>
                <button aria-label={t('a11y.copyPublicKey')} onClick={copyPublicKey} className="text-verde flex-shrink-0">
                  <span className="material-symbols-outlined text-lg">{copiedPub ? 'check' : 'content_copy'}</span>
                </button>
              </div>
              <p className="text-[11px] text-gris mt-1 ml-1">Puedes compartir esta dirección para recibir fondos.</p>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-sm p-4">
              <label className="block text-xs font-bold text-red-800 uppercase tracking-wider mb-2 flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">warning</span>
                Tu Llave Secreta (Backup)
              </label>
              <p className="text-[11px] text-red-700 mb-3 leading-relaxed">
                Esta es la única forma de recuperar tu cuenta si pierdes o cambias de dispositivo. <strong>NUNCA la compartas con nadie</strong>. Quien la tenga controla tus fondos.
              </p>
              <button
                onClick={() => setShowBackupModal(true)}
                className={`w-full font-bold py-3 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[3px] active:translate-y-[3px] ${
                  backedUp
                    ? 'bg-[#E6F9F1] text-[#1D9E75]'
                    : 'bg-red-100 hover:bg-red-200 text-red-800'
                }`}
              >
                <span className="material-symbols-outlined text-base">
                  {backedUp ? 'check_circle' : 'visibility'}
                </span>
                {backedUp ? 'Llave respaldada' : 'Respaldar mi llave'}
              </button>
            </div>
          </div>

          <button
            onClick={finishOnboarding}
            className="w-full min-h-12 bg-naranja text-papel border-2 border-tinta shadow-solida font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs"
          >
            Continuar y explorar
          </button>
          {!backedUp && (
            <p className="text-[11px] text-[#67808C] text-center leading-relaxed">
              Puedes continuar sin respaldar, pero te lo pediremos otra vez antes de tu
              primera operación con fondos.
            </p>
          )}

          {showBackupModal && (
            <SecretKeyBackupModal
              secretKey={secretKey}
              onClose={() => setShowBackupModal(false)}
              onConfirmed={() => setBackedUp(true)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fondo flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm bg-papel rounded-sm p-8 space-y-6">
        <div className="text-center">
          <h1 className="font-extrabold text-2xl text-tinta">Crear cuenta</h1>
          <p className="text-sm text-gris mt-1">Tu identidad Stellar se genera en tu dispositivo</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-sm px-4 py-3">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {deviceHasAccount && (
          <div className="border-2 border-tinta bg-verde-suave rounded-sm px-4 py-3 space-y-3">
            <p className="text-sm text-tinta">
              Este teléfono ya tiene una cuenta de Micopay. No necesitas otro nombre de
              usuario: tu llave ya prueba que es tuya.
            </p>
            <button
              onClick={handleUseExistingAccount}
              disabled={loading}
              className="w-full min-h-12 bg-naranja text-papel border-2 border-tinta shadow-solida font-bold py-3 rounded-sm transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs disabled:opacity-60"
            >
              {loading ? 'Entrando…' : 'Entrar a mi cuenta'}
            </button>
          </div>
        )}

        <div>
          <label className="block text-xs font-bold text-gris uppercase tracking-wider mb-1">
            Nombre de usuario
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            placeholder="mi_usuario"
            className="w-full px-4 py-3 rounded-sm border-2 border-tinta text-tinta text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            autoCapitalize="none"
            autoCorrect="off"
            maxLength={30}
          />
          <p className="text-[11px] text-gris mt-1 ml-1">Solo letras, números y guiones bajos</p>
        </div>

        <div>
          <label className="block text-xs font-bold text-gris uppercase tracking-wider mb-1">
            Teléfono <span className="text-gris font-normal normal-case">(opcional)</span>
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            placeholder="+52 55 1234 5678"
            className="w-full px-4 py-3 rounded-sm border-2 border-tinta text-tinta text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            autoCapitalize="none"
            autoCorrect="off"
            maxLength={20}
          />
          <p className="text-[11px] text-gris mt-1 ml-1">
            Opcional. Se hashea localmente (SHA-256) — el número nunca se envía al servidor.
            Ayuda a prevenir el abuso de cuentas relacionadas.
          </p>
        </div>

        <div className="bg-[#E8F5EE] rounded-sm p-4 flex items-start gap-3">
          <span className="material-symbols-outlined text-verde text-lg mt-0.5">key</span>
          <p className="text-xs text-verde leading-relaxed">
            Se generará un keypair Stellar en tu dispositivo. Tu clave privada <strong>nunca sale del teléfono</strong>. Guarda tu nombre de usuario — lo necesitarás para recuperar el acceso.
          </p>
        </div>

        <button
          onClick={handleRegister}
          disabled={loading}
          className="w-full min-h-12 bg-naranja text-papel border-2 border-tinta shadow-solida font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs disabled:opacity-60"
        >
          {loading ? (
            <>
              <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
              Generando identidad…
            </>
          ) : (
            'Crear cuenta'
          )}
        </button>

        <p className="text-center text-sm text-gris">
          ¿Ya tienes cuenta?{' '}
          <button
            onClick={() => navigate('/login')}
            className="inline-flex min-h-12 items-center justify-center text-verde font-bold underline"
          >
            Inicia sesión
          </button>
        </p>
      </div>
    </div>
  );
}
