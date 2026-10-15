import { useEffect, useState } from 'react';
import { SecureScreen } from '../lib/secureScreen';

/**
 * Revela la llave secreta Stellar para que el usuario la anote.
 *
 * Sustituye al mecanismo anterior, que copiaba la llave al portapapeles del
 * sistema (auditoría 2026-08, ISSUE-03 / SEC-33). Ese camino tenía tres
 * problemas: en Android 13+ el sistema previsualiza en pantalla lo que se
 * copia, el contenido se queda en el portapapeles indefinidamente, y desde un
 * WebView no se puede marcar como sensible con EXTRA_IS_SENSITIVE.
 *
 * Aquí la llave se muestra con FLAG_SECURE activo — capturas y grabación
 * bloqueadas — y no pasa por el portapapeles en ningún momento.
 *
 * Con `requireConfirmation`, además obliga a transcribir los últimos cuatro
 * caracteres. Sin eso, el usuario podía dar por respaldada una llave que nunca
 * llegó a escribir en ninguna parte.
 */

interface SecretKeyBackupModalProps {
  secretKey: string;
  onClose: () => void;
  /** Se llama solo si el usuario demuestra haber transcrito la llave. */
  onConfirmed?: () => void;
  /** Si es false, se puede cerrar sin transcribir (export desde Perfil). */
  requireConfirmation?: boolean;
  /**
   * Por que aparece. El alta y el export desde Perfil los abre el usuario, asi
   * que el motivo se sobreentiende; la compuerta previa a la primera operacion
   * con fondos salta sola y sin esto el usuario no sabe por que.
   */
  reason?: string;
}

const CONFIRM_CHARS = 4;

const DEFAULT_REASON =
  'Anótala en papel y guárdala fuera del teléfono. Es la única forma de recuperar tu ' +
  'cuenta. Quien la tenga controla tus fondos.';

export default function SecretKeyBackupModal({
  secretKey,
  onClose,
  onConfirmed,
  requireConfirmation = true,
  reason = DEFAULT_REASON,
}: SecretKeyBackupModalProps) {
  const [revealed, setRevealed] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const expected = secretKey.slice(-CONFIRM_CHARS);

  useEffect(() => {
    SecureScreen.enable().catch(() => {});
    // Se retira al desmontar pase lo que pase: si el usuario cancela, navega
    // atrás o el componente cae por un error, la app no puede quedarse con las
    // capturas bloqueadas para el resto de la sesión.
    return () => {
      SecureScreen.disable().catch(() => {});
    };
  }, []);

  const handleConfirm = () => {
    if (input.trim().toUpperCase() !== expected.toUpperCase()) {
      setError('No coincide. Revisa los últimos 4 caracteres de tu llave.');
      return;
    }
    setError(null);
    onConfirmed?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[110] flex items-center justify-center p-6 animate-fade-in">
      <div className="bg-white rounded-3xl w-full max-w-sm p-6 shadow-2xl">
        <div className="text-center mb-5">
          <div className="w-14 h-14 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-3 text-red-500">
            <span className="material-symbols-outlined text-3xl">key</span>
          </div>
          <h2 className="text-lg font-extrabold text-[#0B1E26]">Respalda tu llave secreta</h2>
          <p className="text-sm text-[#67808C] mt-2 leading-relaxed">{reason}</p>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-red-800 uppercase tracking-wider">
              Tu llave secreta
            </span>
            <span className="text-[11px] text-red-700 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">screenshot_monitor</span>
              Capturas bloqueadas
            </span>
          </div>

          {revealed ? (
            <p className="font-mono text-xs text-[#0B1E26] break-all select-all leading-relaxed">
              {secretKey}
            </p>
          ) : (
            <button
              onClick={() => setRevealed(true)}
              aria-label="Mostrar la llave secreta"
              className="w-full bg-red-100 hover:bg-red-200 text-red-800 font-bold py-3 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
            >
              <span className="material-symbols-outlined text-base">visibility</span>
              Mostrar llave
            </button>
          )}
        </div>

        {revealed && requireConfirmation && (
          <div className="mb-4">
            <label
              htmlFor="secret-confirm"
              className="block text-xs font-semibold text-[#0B1E26] mb-2"
            >
              Para confirmar que la anotaste, escribe sus últimos {CONFIRM_CHARS} caracteres:
            </label>
            <input
              id="secret-confirm"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              maxLength={CONFIRM_CHARS}
              autoCapitalize="characters"
              autoComplete="off"
              className="w-full border border-[#D7E3EA] rounded-xl px-4 py-3 font-mono text-center tracking-[0.3em] focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="••••"
            />
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {revealed && requireConfirmation ? (
            <button
              onClick={handleConfirm}
              disabled={input.trim().length < CONFIRM_CHARS}
              className="w-full bg-[#00694C] text-white font-bold py-3.5 rounded-2xl transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Ya la anoté
            </button>
          ) : (
            revealed && (
              <button
                onClick={onClose}
                className="w-full bg-[#00694C] text-white font-bold py-3.5 rounded-2xl transition-all active:scale-[0.98]"
              >
                Listo
              </button>
            )
          )}
          <button
            onClick={onClose}
            className="w-full text-[#67808C] font-semibold py-2.5 rounded-2xl hover:bg-[#EFF6FA] transition-colors"
          >
            {revealed && requireConfirmation ? 'Ahora no' : 'Cerrar'}
          </button>
        </div>
      </div>
    </div>
  );
}
