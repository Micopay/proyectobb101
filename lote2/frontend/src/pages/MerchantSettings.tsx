import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMerchantConfig, updateMerchantConfigWithOfflineSupport, updateMerchantLocation, getCurrentUser, setAvailability, MerchantConfig } from '../services/api';
import { resolveErrorMessage } from '../constants/errorMap';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useGeolocation } from '../hooks/useGeolocation';
import MapReal from '../components/MapReal';

interface MerchantSettingsProps {
  token: string | null;
  onBack: () => void;
}

interface LocationState {
  latitude: number | null;
  longitude: number | null;
  area_label: string | null;
  meeting_point: string | null;
  publish_storefront: boolean;
}

export default function MerchantSettings({
  token,
  onBack,
}: MerchantSettingsProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    rate_percent: 1,
    min_trade_mxn: 100,
    max_trade_mxn: 50000,
    daily_cap_mxn: 250000,
  });
  const [availability, setAvailabilityState] = useState<
    "online" | "offline" | "paused"
  >("online");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<'success' | 'error' | 'warning' | null>(null);
  const offlineQueue = useOfflineQueue(token);

  // Location (WP2): loaded from the same GET /merchants/me/config call, kept separate
  // from `form` because PUT /merchants/me/config rejects unknown properties.
  const [location, setLocation] = useState<LocationState>({ latitude: null, longitude: null, area_label: null, meeting_point: null, publish_storefront: false });
  const [editingLocation, setEditingLocation] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [addressText, setAddressText] = useState('');
  // RED-3: consentimiento explicito para publicar el punto exacto. Por
  // omision false: escribirlo no equivale a autorizar su publicacion.
  const [publishStorefront, setPublishStorefront] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const geo = useGeolocation(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        const [config, user] = await Promise.all([
          getMerchantConfig(token),
          getCurrentUser(token),
        ]);
        setForm(config);
        setLocation({
          latitude: config.latitude ?? null,
          longitude: config.longitude ?? null,
          area_label: config.area_label ?? null,
          meeting_point: config.meeting_point ?? null,
          publish_storefront: config.publish_storefront ?? false,
        });
        setAddressText(config.meeting_point ?? '');
        setPublishStorefront(config.publish_storefront ?? false);
        // KYC-1: era `(user as any).verification_status`. El cast tapaba que
        // el campo no existe; el estado real es `availability`.
        const status = user.availability;
        // Y comparaba contra "verified", un valor que ese campo nunca tuvo.
        setAvailabilityState(
          status === "online"
            ? "online"
            : status === "paused"
              ? "paused"
              : "offline",
        );
      } catch (err: any) {
        setMessage(resolveErrorMessage(err).message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  // Once GPS coords arrive from the CTA, seed the picker with them.
  useEffect(() => {
    if (geo.lat != null && geo.lng != null) {
      setPickerPosition({ lat: geo.lat, lng: geo.lng });
    }
  }, [geo.lat, geo.lng]);

  const startLocationEdit = () => {
    setEditingLocation(true);
    if (location.latitude != null && location.longitude != null) {
      setPickerPosition({ lat: location.latitude, lng: location.longitude });
    }
  };

  const saveLocation = async () => {
    if (!token || !pickerPosition) return;
    setSavingLocation(true);
    setMessage(null);
    setMessageType(null);
    try {
      const result = await updateMerchantLocation(
        {
          latitude: pickerPosition.lat,
          longitude: pickerPosition.lng,
          // RED-3: lo que el proveedor escribe aqui es el PUNTO DE
          // ENCUENTRO, privado por omision. Publicarlo es una decision
          // aparte y explicita; no se infiere de que este lleno.
          meeting_point: addressText.trim() ? addressText.trim() : undefined,
          publish_storefront: publishStorefront,
        },
        token,
      );
      setLocation({
        latitude: result.latitude,
        longitude: result.longitude,
        area_label: result.area_label,
        meeting_point: result.meeting_point,
        publish_storefront: result.publish_storefront,
      });
      setEditingLocation(false);
      setMessage(t('merchantSettings.location.saveSuccess'));
      setMessageType('success');
    } catch (err: any) {
      setMessage(resolveErrorMessage(err).message);
      setMessageType('error');
    } finally {
      setSavingLocation(false);
    }
  };

  const togglePause = async () => {
    if (!token) return;
    const next = availability === "paused" ? "online" : "paused";
    setSaving(true);
    try {
      await setAvailability(next, token);
      setAvailabilityState(next);
      setMessage(
        next === "paused" ? "Operaciones pausadas" : "Operaciones reanudadas",
      );
    } catch (err: any) {
      setMessage("No se pudo cambiar el estado");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setMessage(null);
    setMessageType(null);
    try {
      const result = await updateMerchantConfigWithOfflineSupport(
        token,
        form,
        offlineQueue.queueMutationAsync,
      );
      
      setForm(result.config);
      
      if (result.queued) {
        setMessage('⏳ Cambios guardados localmente. Se sincronizarán cuando la conexión se restaure.');
        setMessageType('warning');
      } else {
        setMessage('✅ Configuración guardada exitosamente. El límite diario se reinicia a las 00:00 UTC.');
        setMessageType('success');
      }
    } catch (err: any) {
      setMessage(resolveErrorMessage(err).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface text-on-surface min-h-screen px-6 pt-10 pb-32 max-w-xl mx-auto">
      <button className="mb-6 text-sm font-semibold text-verde" onClick={onBack}>← Volver</button>
      <h1 className="text-2xl font-bold mb-2">Ajustes del comerciante</h1>
      <p className="text-sm text-on-surface-variant mb-8">Configura tu tasa y límites de operación.</p>

      {loading ? (
        <p>Cargando…</p>
      ) : (
        <div className="space-y-5">
          <section className="bg-papel rounded-sm p-5 border border-slate-100 mb-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-bold text-on-surface">
                  Estado de operaciones
                </p>
                <p className="text-xs text-on-surface-variant">
                  {availability === "paused"
                    ? "Tu negocio está pausado"
                    : "Estás recibiendo solicitudes"}
                </p>
              </div>
              <button
                onClick={togglePause}
                disabled={saving}
                className={`px-6 py-2 rounded-full font-bold text-xs transition-all ${
                  availability === "paused"
                    ? "bg-emerald-500 text-papel shadow-emerald-500/20"
                    : "bg-error text-papel shadow-error/20"
                }`}
              >
                {availability === "paused" ? "Reanudar" : "Pausar"}
              </button>
            </div>
          </section>

          <Field
            label="Tasa (%)"
            value={form.rate_percent}
            step="0.1"
            onChange={(v) =>
              setForm((f) => ({ ...f, rate_percent: Number(v) }))
            }
          />
          <Field
            label="Monto mínimo (MXN)"
            value={form.min_trade_mxn}
            onChange={(v) =>
              setForm((f) => ({ ...f, min_trade_mxn: Number(v) }))
            }
          />
          <Field
            label="Monto máximo (MXN)"
            value={form.max_trade_mxn}
            onChange={(v) =>
              setForm((f) => ({ ...f, max_trade_mxn: Number(v) }))
            }
          />
          <Field
            label="Tope diario (MXN)"
            value={form.daily_cap_mxn}
            onChange={(v) =>
              setForm((f) => ({ ...f, daily_cap_mxn: Number(v) }))
            }
          />

          <section className="bg-papel rounded-sm p-5 border border-slate-100 mb-8">
            <p className="font-bold text-on-surface mb-1">{t('merchantSettings.location.title')}</p>

            {!editingLocation && location.latitude != null && location.longitude != null ? (
              <div className="space-y-3">
                <MapReal
                  pickerMode
                  pickerPosition={{ lat: location.latitude, lng: location.longitude }}
                  userPosition={{ lat: location.latitude, lng: location.longitude }}
                />
                {location.meeting_point && (
                  <p className="text-sm text-on-surface-variant">{location.meeting_point}</p>
                )}
                <button
                  type="button"
                  className="w-full rounded-sm border border-primary text-verde font-semibold py-2.5"
                  onClick={startLocationEdit}
                >
                  {t('merchantSettings.location.change')}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {!pickerPosition && (
                  <>
                    <p className="text-xs text-on-surface-variant">{t('merchantSettings.location.notSet')}</p>
                    <button
                      type="button"
                      className="w-full rounded-sm bg-verde text-papel font-semibold py-2.5 disabled:opacity-60"
                      disabled={geo.loading}
                      onClick={() => geo.requestPermission()}
                    >
                      {geo.loading ? t('merchantSettings.location.gettingLocation') : t('merchantSettings.location.useCurrent')}
                    </button>
                    {geo.error && (
                      <p className="text-xs text-error">{t('merchantSettings.location.locationError')}</p>
                    )}
                  </>
                )}

                {pickerPosition && (
                  <div className="space-y-3">
                    <MapReal
                      pickerMode
                      pickerPosition={pickerPosition}
                      userPosition={pickerPosition}
                      onPickerPositionChange={setPickerPosition}
                    />
                    <p className="text-xs text-on-surface-variant">{t('merchantSettings.location.dragHint')}</p>

                    <label className="block">
                      <span className="block text-sm font-medium mb-2">{t('merchantSettings.location.addressLabel')}</span>
                      <input
                        type="text"
                        maxLength={200}
                        value={addressText}
                        placeholder={t('merchantSettings.location.addressPlaceholder')}
                        onChange={(e) => setAddressText(e.target.value)}
                        className="w-full rounded-sm border border-slate-200 px-4 py-3"
                      />
                      {/* RED-3: decir con claridad qué es público y qué no.
                          El criterio del issue pide exactamente esto. */}
                      <p className="mt-2 text-xs text-gris leading-relaxed">
                        Esto es tu <strong>punto de encuentro</strong> y es privado: solo lo ve
                        la persona con la que ya tienes una operación aceptada. En el mapa
                        público únicamente aparece tu ubicación aproximada, redondeada a unos
                        100 metros.
                      </p>
                    </label>

                    {/* RED-3: consentimiento explícito. Escribir la dirección
                        no equivale a autorizar su publicación. */}
                    <label className="flex items-start gap-3 rounded-sm border-2 border-tinta bg-fondo p-3">
                      <input
                        type="checkbox"
                        checked={publishStorefront}
                        onChange={(e) => setPublishStorefront(e.target.checked)}
                        className="mt-0.5 h-5 w-5 flex-shrink-0"
                      />
                      <span className="text-xs text-tinta leading-relaxed">
                        <strong>Publicar mi dirección en el mapa.</strong> Márcalo solo si
                        atiendes en un local comercial y quieres que cualquiera pueda verla
                        sin haber iniciado una operación. Si operas desde tu casa, déjalo sin
                        marcar.
                      </span>
                    </label>

                    <div className="flex gap-3">
                      {editingLocation && (
                        <button
                          type="button"
                          className="flex-1 rounded-sm border border-slate-200 text-on-surface-variant font-semibold py-2.5"
                          onClick={() => setEditingLocation(false)}
                        >
                          {t('merchantSettings.location.cancel')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex-1 rounded-sm bg-verde text-papel font-semibold py-2.5 disabled:opacity-60"
                        disabled={savingLocation}
                        onClick={saveLocation}
                      >
                        {savingLocation ? t('merchantSettings.location.saving') : t('merchantSettings.location.save')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          <button
            className="w-full rounded-sm bg-verde text-papel font-semibold py-3 disabled:opacity-60"
            disabled={saving || !token || offlineQueue.isSyncing}
            onClick={save}
          >
            {saving ? 'Guardando…' : offlineQueue.isSyncing ? 'Sincronizando...' : 'Guardar cambios'}
          </button>

          {message && (
            <p className={`text-sm font-medium p-3 rounded ${
              messageType === 'success' ? 'bg-green-50 text-green-800 border border-green-200' :
              messageType === 'error' ? 'bg-red-50 text-red-800 border border-red-200' :
              'bg-amber-50 text-amber-800 border border-amber-200'
            }`}>
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  step = "1",
}: {
  label: string;
  value: number;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-2">{label}</span>
      <input
        type="text"
                  inputMode="decimal"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-sm border border-slate-200 px-4 py-3"
      />
    </label>
  );
}
