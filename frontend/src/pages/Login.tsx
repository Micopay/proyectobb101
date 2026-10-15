import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { UserData, getAuthToken, getCurrentUser } from '../services/api';
import { writeJSON } from '../services/secureStorage';
import { generateAndStoreKeypair, keypairExists, importKeypair } from '../lib/keystore';

const USERS_STORAGE_KEY = 'micopay_user';

interface LoginProps {
  onLoginSuccess: (buyer: UserData, seller: UserData | null) => void;
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [secretKey, setSecretKey] = useState('');

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      if (!await keypairExists()) {
        await generateAndStoreKeypair();
      }
      const token = await getAuthToken();
      const profile = await getCurrentUser(token);
      const user: UserData = { id: profile.id, username: profile.username, token };
      await writeJSON(USERS_STORAGE_KEY, user);
      onLoginSuccess(user, null);
      navigate(from, { replace: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error al iniciar sesión';
      if (msg.includes('404') || msg.includes('USER_NOT_FOUND') || msg.includes('no encontrado')) {
        setError('No encontré tu cuenta en este dispositivo. Si cambiaste de teléfono o reinstalaste la app, usa "Restaurar con llave secreta".');
      } else if (msg.includes('Network') || msg.includes('fetch')) {
        setError('Sin conexión al servidor. Intenta en unos segundos.');
      } else {
        setError(`Error: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!secretKey.trim().startsWith('S') || secretKey.trim().length < 56) {
      setError('La llave secreta debe empezar con "S" y tener 56 caracteres.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await importKeypair(secretKey.trim());
      const token = await getAuthToken();
      const profile = await getCurrentUser(token);
      const user: UserData = { id: profile.id, username: profile.username, token };
      await writeJSON(USERS_STORAGE_KEY, user);
      onLoginSuccess(user, null);
      navigate(from, { replace: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error al restaurar';
      if (msg.includes('Invalid') || msg.includes('secret') || msg.includes('fromSecret')) {
        setError('Llave secreta inválida. Verifica que la copiaste completa.');
      } else if (msg.includes('404') || msg.includes('USER_NOT_FOUND')) {
        setError('Esta llave no corresponde a ninguna cuenta registrada.');
      } else {
        setError(`Error: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-fondo flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm bg-papel rounded-sm p-8 space-y-6">
        <div className="text-center">
          <h1 className="font-extrabold text-2xl text-tinta">MicoPay</h1>
          <p className="text-sm text-gris mt-1">
            {showRestore ? 'Restaura tu cuenta con tu llave secreta' : 'Ingresa a tu cuenta'}
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-sm px-4 py-3">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* Antes había aquí un campo "Nombre de usuario" que nunca se enviaba
              a ningún lado: el login es por firma de la llave del dispositivo,
              y el servidor resuelve la cuenta por dirección Stellar. Pedir un
              dato que se ignora hacía creer que un nombre equivocado era la
              causa de los errores de sesión. */}
          {!showRestore && (
            <p className="text-sm text-gris text-center">
              Entras con la llave guardada en este teléfono. No necesitas contraseña.
            </p>
          )}

          {showRestore && (
            <div>
              <label className="block text-xs font-bold text-gris uppercase tracking-wider mb-1">
                Llave secreta (empieza con S…)
              </label>
              <input
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="SABCD…"
                className="w-full px-4 py-3 rounded-sm border-2 border-tinta text-tinta text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
              />
            </div>
          )}
        </div>

        <button
          onClick={showRestore ? handleRestore : handleLogin}
          disabled={loading}
          className="w-full min-h-12 bg-naranja text-papel border-2 border-tinta shadow-solida font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs disabled:opacity-60"
        >
          {loading ? (
            <>
              <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
              {showRestore ? 'Restaurando…' : 'Entrando…'}
            </>
          ) : (
            showRestore ? 'Restaurar cuenta' : 'Entrar'
          )}
        </button>

        <div className="flex flex-col gap-2 text-center text-sm text-gris">
          <button
            onClick={() => { setShowRestore(!showRestore); setError(null); setSecretKey(''); }}
            className="inline-flex min-h-12 items-center justify-center text-verde font-bold underline"
          >
            {showRestore ? '← Volver al login normal' : 'Restaurar con llave secreta'}
          </button>
          {!showRestore && (
            <span>
              ¿No tienes cuenta?{' '}
              <button onClick={() => navigate('/register')} className="inline-flex min-h-12 items-center justify-center text-verde font-bold underline">
                Regístrate
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
