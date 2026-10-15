/**
 * I18N-3: the offline-sync banner must speak the reader's language.
 *
 * The bug this pins down is the order of events. A provider using the app in
 * English saw this banner in Spanish exactly when something had already gone
 * wrong - no connection, or changes stuck waiting for the server - which is the
 * worst possible moment to be unable to read what the app is telling you.
 *
 * The Spanish copy is asserted literally, character for character, against the
 * strings that were hardcoded before this component used t(). That is the point
 * of the ticket: the words a provider already knows must not change just
 * because we moved them into es.json.
 *
 * useOfflineQueue is mocked wholesale, so nothing here touches IndexedDB, the
 * queue, or the network. The hook only decides which of the three branches
 * renders, so the mock is the whole contract under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import i18n from '../i18n';
import OfflineQueueStatus from '../components/OfflineQueueStatus';

// vi.mock is hoisted above the imports, so the state it closes over has to be
// hoisted with it or the factory would read a binding that does not exist yet.
const h = vi.hoisted(() => ({
  isOnline: true,
  hasPending: false,
  isSyncing: false,
  retryAsync: vi.fn(async () => {}),
}));

vi.mock('../hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({
    isOnline: h.isOnline,
    hasPending: h.hasPending,
    isSyncing: h.isSyncing,
    retryAsync: h.retryAsync,
    queueMutationAsync: vi.fn(async () => 'queued'),
  }),
}));

const TOKEN = 'jwt-de-proveedor';

// The exact strings the component showed before the change. Compact and full
// "pending" labels are the same words in both languages, so the mode tests
// assert the *other* variant is absent to prove which branch rendered.
const ES = {
  compactOffline: 'Sin conexión',
  compactPending: 'Pendiente de sincronizar',
  offlineTitle: 'Sin conexión a Internet',
  offlineBody:
    'Tus cambios se guardarán localmente y se sincronizarán automáticamente cuando se restaure la conexión.',
  pendingTitle: 'Pendiente de sincronizar',
  pendingBody: 'Tienes cambios esperando ser sincronizados con el servidor.',
  retry: 'Reintentar',
};

const EN = {
  compactOffline: 'Offline',
  compactPending: 'Pending sync',
  offlineTitle: 'No internet connection',
  offlineBody:
    'Your changes are saved on this device and will sync automatically once the connection is back.',
  pendingTitle: 'Pending sync',
  pendingBody: 'You have changes waiting to be synced with the server.',
  retry: 'Retry',
};

async function renderIn(lang: 'es' | 'en', props: { compact?: boolean } = {}) {
  await i18n.changeLanguage(lang);
  return render(<OfflineQueueStatus token={TOKEN} {...props} />);
}

beforeEach(() => {
  h.isOnline = true;
  h.hasPending = false;
  h.isSyncing = false;
  h.retryAsync.mockClear();
});

afterEach(async () => {
  cleanup();
  // Leave the shared instance on the app default so a test can never leak its
  // language into the next file that imports the same i18n module.
  await i18n.changeLanguage('es');
});

describe('OfflineQueueStatus - compact mode', () => {
  it('shows the short offline label in Spanish', async () => {
    h.isOnline = false;
    await renderIn('es', { compact: true });
    expect(screen.getByText(ES.compactOffline)).toBeInTheDocument();
    // The full banner's heading is a different string, so its absence is what
    // proves this rendered the compact branch and not the full one.
    expect(screen.queryByText(ES.offlineTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ES.offlineBody)).not.toBeInTheDocument();
  });

  it('shows the short offline label in English', async () => {
    h.isOnline = false;
    await renderIn('en', { compact: true });
    expect(screen.getByText(EN.compactOffline)).toBeInTheDocument();
    // The regression itself: this used to read "Sin conexión" in every language.
    expect(screen.queryByText(ES.compactOffline)).not.toBeInTheDocument();
    expect(screen.queryByText(EN.offlineTitle)).not.toBeInTheDocument();
  });

  it('shows the short pending label in Spanish', async () => {
    h.isOnline = true;
    h.hasPending = true;
    await renderIn('es', { compact: true });
    expect(screen.getByText(ES.compactPending)).toBeInTheDocument();
    // Identical wording to pendingTitle, so the body text is the discriminator.
    expect(screen.queryByText(ES.pendingBody)).not.toBeInTheDocument();
    // Compact has no retry affordance; adding one would change the layout.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the short pending label in English', async () => {
    h.isOnline = true;
    h.hasPending = true;
    await renderIn('en', { compact: true });
    expect(screen.getByText(EN.compactPending)).toBeInTheDocument();
    expect(screen.queryByText(ES.compactPending)).not.toBeInTheDocument();
    expect(screen.queryByText(EN.pendingBody)).not.toBeInTheDocument();
  });
});

describe('OfflineQueueStatus - full mode', () => {
  it('explains the offline state in Spanish, with the copy unchanged', async () => {
    h.isOnline = false;
    await renderIn('es');
    expect(screen.getByText(ES.offlineTitle)).toBeInTheDocument();
    expect(screen.getByText(ES.offlineBody)).toBeInTheDocument();
    expect(screen.queryByText(ES.compactOffline)).not.toBeInTheDocument();
  });

  it('explains the offline state in English', async () => {
    h.isOnline = false;
    await renderIn('en');
    expect(screen.getByText(EN.offlineTitle)).toBeInTheDocument();
    expect(screen.getByText(EN.offlineBody)).toBeInTheDocument();
    expect(screen.queryByText(ES.offlineTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ES.offlineBody)).not.toBeInTheDocument();
  });

  it('explains the pending-sync state in Spanish, with the copy unchanged', async () => {
    h.isOnline = true;
    h.hasPending = true;
    await renderIn('es');
    expect(screen.getByText(ES.pendingTitle)).toBeInTheDocument();
    expect(screen.getByText(ES.pendingBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ES.retry })).toBeInTheDocument();
  });

  it('explains the pending-sync state in English', async () => {
    h.isOnline = true;
    h.hasPending = true;
    await renderIn('en');
    expect(screen.getByText(EN.pendingTitle)).toBeInTheDocument();
    expect(screen.getByText(EN.pendingBody)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: EN.retry })).toBeInTheDocument();
    expect(screen.queryByText(ES.retry)).not.toBeInTheDocument();
  });
});

describe('OfflineQueueStatus - nothing to say', () => {
  it('renders nothing when online with nothing pending', async () => {
    // There is no state to announce, so the component must not leave an empty
    // pill or an empty bordered box in the layout.
    h.isOnline = true;
    h.hasPending = false;
    for (const lang of ['es', 'en'] as const) {
      const { container } = await renderIn(lang);
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  it('prefers the offline banner over the pending one when both are true', async () => {
    // Losing the connection while changes are queued is the common case, and
    // the connection is the more urgent fact to surface. This condition order
    // is pre-existing and out of scope to change - it is pinned so a
    // refactor cannot quietly flip it.
    h.isOnline = false;
    h.hasPending = true;
    await renderIn('es');
    expect(screen.getByText(ES.offlineTitle)).toBeInTheDocument();
    expect(screen.queryByText(ES.pendingTitle)).not.toBeInTheDocument();
  });
});

describe('OfflineQueueStatus - retry still works', () => {
  it('calls retryAsync with the token it was given', async () => {
    // The ticket is text-only, so the one thing that must not change is this:
    // the button is an authenticated retry, and losing the token would turn it
    // into a silent no-op that fails the way the user cannot see.
    h.isOnline = true;
    h.hasPending = true;
    await renderIn('es');
    fireEvent.click(screen.getByRole('button', { name: ES.retry }));
    expect(h.retryAsync).toHaveBeenCalledTimes(1);
    expect(h.retryAsync).toHaveBeenCalledWith(TOKEN);
  });

  it('passes a null token through untouched', async () => {
    h.isOnline = true;
    h.hasPending = true;
    await i18n.changeLanguage('en');
    render(<OfflineQueueStatus token={null} />);
    fireEvent.click(screen.getByRole('button', { name: EN.retry }));
    expect(h.retryAsync).toHaveBeenCalledWith(null);
  });
});

describe('translation resources', () => {
  it('has every offlineQueue key in both languages, with no Spanish left in en', async () => {
    // A key present in only one file renders as the raw key path to a user
    // instead of text, and the failure is invisible in Spanish - the app
    // defaults to es - which is how this class of bug ships.
    const [{ default: es }, { default: en }] = await Promise.all([
      import('../i18n/es.json'),
      import('../i18n/en.json'),
    ]);
    const esKeys = Object.keys((es as any).offlineQueue).sort();
    const enKeys = Object.keys((en as any).offlineQueue).sort();
    expect(enKeys).toEqual(esKeys);
    expect(esKeys.length).toBeGreaterThan(0);
    for (const key of esKeys) {
      const enValue = (en as any).offlineQueue[key];
      expect(enValue, `en.offlineQueue.${key}`).toBeTruthy();
      // Identical es/en values mean the English was never actually written.
      expect(enValue, `en.offlineQueue.${key} is still Spanish`).not.toBe(
        (es as any).offlineQueue[key],
      );
    }
  });

  it('keeps the pre-existing Spanish copy byte for byte', async () => {
    // Guards the other direction: a well-meaning copy edit in es.json would be
    // invisible in a test that only checks the key exists.
    const { default: es } = await import('../i18n/es.json');
    expect((es as any).offlineQueue).toEqual(ES);
  });
});
