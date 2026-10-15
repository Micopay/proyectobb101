import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AvailableMerchant } from '../services/api';

interface MapRealProps {
    type?: 'cashout' | 'deposit';
    merchants?: AvailableMerchant[];
    selectedMerchantId?: string | null;
    onSelectMerchant?: (merchantId: string) => void;
    /** Real user position; if null, fit-bounds only over merchants (or default view if none). */
    userPosition?: { lat: number; lng: number } | null;
    /** When true, renders a single draggable pin instead of merchant markers (location picker use case). */
    pickerMode?: boolean;
    /** Current picker pin position; if null while pickerMode is on, falls back to userPosition as the initial center. */
    pickerPosition?: { lat: number; lng: number } | null;
    /** Called with the new position when the picker pin is dragged. */
    onPickerPositionChange?: (position: { lat: number; lng: number }) => void;
}


// OpenFreeMap: OSM completo a nivel calle, sin API key, uso en producción permitido.
// demotiles.maplibre.org NO sirve como fallback: solo tiene fronteras de países,
// a zoom de calle renderiza un fondo vacío (visto en Huatusco, 2026-07-25).
const FALLBACK_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

function buildMerchantMarkerElement(
    merchant: AvailableMerchant,
    isSelected: boolean,
    onSelectMerchant?: (merchantId: string) => void,
): HTMLElement {
    const wrapper = document.createElement('button');
    wrapper.type = 'button';
    wrapper.setAttribute('aria-label', `Seleccionar ${merchant.username}`);
    wrapper.className = 'flex flex-col items-center focus:outline-none';
    wrapper.style.background = 'transparent';
    wrapper.style.border = 'none';
    wrapper.style.padding = '0';
    wrapper.style.cursor = onSelectMerchant ? 'pointer' : 'default';

    /* El hongo va como SVG inline: este DOM se construye fuera de React, asi
       que no puede usar el componente Hongo. Es el mismo dibujo (mismo
       viewBox y trazos) que src/components/ui/Hongo.tsx.

       Sin glow ni pulso: eran blur + animate-pulse + bg-primary/40, tres
       prohibiciones del sistema de una vez. La jerarquia la da el tamaño y
       la inversion del rotulo, no la luz.

       Los colores van por var(): funcionan aqui porque index.css declara
       @theme static, que obliga a emitir todas las variables. Sin eso, este
       marcador saldria sin color en produccion y bien en dev (R-4 del plan). */
    const pinWrap = document.createElement('span');
    pinWrap.className = 'block transition-transform';
    pinWrap.style.width = isSelected ? '52px' : '44px';
    pinWrap.innerHTML = `
      <svg viewBox="0 0 64 64" fill="none" width="100%" height="100%" aria-hidden="true">
        <path d="M23 30v17a9 7 0 0 0 18 0V30Z" fill="var(--color-fondo)" stroke="var(--color-tinta)" stroke-width="2"/>
        <path d="M4 33C4 16 17 5 32 5s28 11 28 28Z" fill="${isSelected ? 'var(--color-tinta)' : 'var(--color-naranja)'}" stroke="var(--color-tinta)" stroke-width="2"/>
        <circle cx="20" cy="21" r="3.4" fill="${isSelected ? 'var(--color-papel)' : 'var(--color-tinta)'}"/>
        <circle cx="41" cy="16" r="4.2" fill="${isSelected ? 'var(--color-papel)' : 'var(--color-tinta)'}"/>
      </svg>`;

    const label = document.createElement('span');
    label.className = 'mt-1 block whitespace-nowrap rounded-sm border-2 px-2 py-0.5 text-[10px] font-bold';
    label.style.borderColor = 'var(--color-tinta)';
    label.style.background = isSelected ? 'var(--color-tinta)' : 'var(--color-papel)';
    label.style.color = isSelected ? 'var(--color-papel)' : 'var(--color-tinta)';
    label.style.boxShadow = '2px 2px 0 var(--color-tinta)';
    label.textContent = merchant.username;

    wrapper.appendChild(pinWrap);
    wrapper.appendChild(label);

    wrapper.addEventListener('click', () => onSelectMerchant?.(merchant.seller_id));

    return wrapper;
}

function buildPickerMarkerElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'relative flex flex-col items-center';
    container.style.width = '48px';
    container.style.cursor = 'grab';

    const pin = document.createElement('div');
    /* Circulo: es el unico sitio, con el punto del usuario, donde el radio
       completo sigue siendo correcto — es un punto de verdad, no una caja. */
    pin.className = 'relative z-10 w-11 h-11 rounded-full border-2 flex items-center justify-center';
    pin.style.background = 'var(--color-naranja)';
    pin.style.borderColor = 'var(--color-tinta)';
    const dot = document.createElement('span');
    dot.className = 'w-3 h-3 rounded-full bg-papel';
    pin.appendChild(dot);
    container.appendChild(pin);

    return container;
}

function buildUserMarkerElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'relative flex items-center justify-center';
    container.style.width = '64px';
    container.style.height = '64px';

    const dot = document.createElement('div');
    dot.className = 'w-6 h-6 rounded-full border-2 relative z-10';
    dot.style.background = 'var(--color-verde)';
    dot.style.borderColor = 'var(--color-tinta)';
    container.appendChild(dot);

    return container;
}

/**
 * Real MapLibre GL map. Drop-in replacement for the deprecated `MapSim`
 * (same visual footprint + prop-compatible superset), but renders actual
 * tiles/pan/zoom centered on the user's real GPS position instead of a
 * static PNG.
 */
const MapReal = ({
    type = 'cashout',
    merchants = [],
    selectedMerchantId,
    onSelectMerchant,
    userPosition = null,
    pickerMode = false,
    pickerPosition = null,
    onPickerPositionChange,
}: MapRealProps) => {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const markersRef = useRef<maplibregl.Marker[]>([]);
    const userMarkerRef = useRef<maplibregl.Marker | null>(null);
    const pickerMarkerRef = useRef<maplibregl.Marker | null>(null);
    // Keep the latest callback in a ref so the marker's dragend listener (bound once
    // per marker instance) always calls the current handler without re-creating the marker.
    const onPickerPositionChangeRef = useRef(onPickerPositionChange);
    onPickerPositionChangeRef.current = onPickerPositionChange;

    const styleUrl = import.meta.env.VITE_MAP_STYLE_URL || FALLBACK_STYLE_URL;

    // Create the map once on mount.
    useEffect(() => {
        if (!containerRef.current) return;

        const map = new maplibregl.Map({
            container: containerRef.current,
            style: styleUrl,
            center: [-99.1332, 19.4326], // Mexico City default, used only until fitBounds/setCenter runs below.
            zoom: 11,
            // OSM exige atribución visible; compact la deja como un botón ⓘ discreto.
            attributionControl: { compact: true },
        });

        mapRef.current = map;
        map.on('error', (e) => console.error('[MapReal] tile/style error', e?.error?.message ?? e));

        return () => {
            markersRef.current.forEach((marker) => marker.remove());
            markersRef.current = [];
            userMarkerRef.current?.remove();
            userMarkerRef.current = null;
            pickerMarkerRef.current?.remove();
            pickerMarkerRef.current = null;
            map.remove();
            mapRef.current = null;
        };
        // Intentionally only on mount: style URL is effectively static per build.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Picker mode: single draggable pin, no merchant markers, no fitBounds-over-merchants logic.
    useEffect(() => {
        if (!pickerMode) return;
        const map = mapRef.current;
        if (!map) return;

        const applyPickerUpdate = () => {
            const initialPosition = pickerPosition ?? userPosition;

            if (!pickerMarkerRef.current) {
                if (!initialPosition) return;
                const element = buildPickerMarkerElement();
                const marker = new maplibregl.Marker({ element, draggable: true })
                    .setLngLat([initialPosition.lng, initialPosition.lat])
                    .addTo(map);
                marker.on('dragend', () => {
                    const lngLat = marker.getLngLat();
                    onPickerPositionChangeRef.current?.({ lat: lngLat.lat, lng: lngLat.lng });
                });
                pickerMarkerRef.current = marker;
                map.setCenter([initialPosition.lng, initialPosition.lat]);
                map.setZoom(16);
            } else if (pickerPosition) {
                pickerMarkerRef.current.setLngLat([pickerPosition.lng, pickerPosition.lat]);
            }
        };

        if (map.isStyleLoaded()) {
            applyPickerUpdate();
        } else {
            map.once('load', applyPickerUpdate);
        }
    }, [pickerMode, pickerPosition, userPosition]);

    // Update markers + camera whenever merchants/selection/user position change.
    // Skipped entirely in picker mode — the picker effect above owns the map in that case.
    useEffect(() => {
        if (pickerMode) return;
        const map = mapRef.current;
        if (!map) return;

        const applyUpdate = () => {
            // Clear previous merchant markers.
            markersRef.current.forEach((marker) => marker.remove());
            markersRef.current = [];

            const validMerchants = merchants.filter(
                (merchant) => Number.isFinite(merchant.latitude) && Number.isFinite(merchant.longitude),
            );

            validMerchants.forEach((merchant, index) => {
                const isSelected = selectedMerchantId === merchant.seller_id;
                const element = buildMerchantMarkerElement(merchant, isSelected, onSelectMerchant);

                const marker = new maplibregl.Marker({ element })
                    .setLngLat([merchant.longitude, merchant.latitude])
                    .addTo(map);

                markersRef.current.push(marker);
            });

            // User marker.
            userMarkerRef.current?.remove();
            userMarkerRef.current = null;
            if (userPosition) {
                const userEl = buildUserMarkerElement();
                userMarkerRef.current = new maplibregl.Marker({ element: userEl })
                    .setLngLat([userPosition.lng, userPosition.lat])
                    .addTo(map);
            }

            // Camera.
            if (userPosition && validMerchants.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                bounds.extend([userPosition.lng, userPosition.lat]);
                validMerchants.forEach((merchant) => bounds.extend([merchant.longitude, merchant.latitude]));
                map.fitBounds(bounds, { padding: 48, maxZoom: 16 });
            } else if (validMerchants.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                validMerchants.forEach((merchant) => bounds.extend([merchant.longitude, merchant.latitude]));
                map.fitBounds(bounds, { padding: 48, maxZoom: 16 });
            } else if (userPosition) {
                map.setCenter([userPosition.lng, userPosition.lat]);
                map.setZoom(14);
            }
            // Neither user nor merchants: leave the map at its default style center/zoom.
        };

        if (map.isStyleLoaded()) {
            applyUpdate();
        } else {
            map.once('load', applyUpdate);
        }
    }, [merchants, selectedMerchantId, userPosition, type, onSelectMerchant, pickerMode]);

    return (
        <div className="relative w-full h-64 bg-surface-container-low rounded-sm overflow-hidden border-2 border-tinta shadow-inner group">
            {/* w-full/h-full explícitos: maplibre-gl.css fuerza position:relative sobre
                .maplibregl-map y anula el `absolute` de Tailwind, colapsando el alto a 0. */}
            <div ref={containerRef} className="absolute inset-0 w-full h-full" />

            {merchants.length > 0 && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-papel/90 px-4 py-1.5 rounded-full border-2 border-tinta flex items-center gap-2 z-20 pointer-events-none">
                    <span className="material-symbols-outlined text-verde text-sm font-bold">location_on</span>
                    <p className="text-[10px] font-bold text-on-surface uppercase tracking-widest">
                        {t('map.agentsNearby', { count: merchants.length })}
                    </p>
                </div>
            )}

        </div>
    );
};

export default MapReal;
