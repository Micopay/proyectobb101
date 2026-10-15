/**
 * Offline Queue Service
 * 
 * Manages a local IndexedDB queue for idempotent merchant mutations
 * (availability and settings changes) that can be synced when connectivity
 * is restored.
 */

import type { MerchantConfig } from './api';

/**
 * Forma exacta del payload de cada tipo de mutación.
 *
 * Esto existe porque quien encolaba y quien sincronizaba no se pusieron de
 * acuerdo: se encolaba `{ available }` y el sincronizador leía
 * `payload.merchant_available`, así que enviaba `undefined` al backend. Con el
 * mapa de abajo, un desajuste así lo atrapa TypeScript en vez del usuario.
 *
 * El import de MerchantConfig es `import type`, se borra al compilar y no crea
 * dependencia circular con api.ts.
 */
export interface ConfigMutationPayload {
  config: MerchantConfig;
}

export interface AvailabilityMutationPayload {
  merchant_available: boolean;
}

export interface MutationPayloadMap {
  config: ConfigMutationPayload;
  availability: AvailabilityMutationPayload;
}

export type MutationType = keyof MutationPayloadMap;

/** Par tipo+payload correlacionado, para poder discriminar por `type`. */
export type QueuedMutation = {
  [K in MutationType]: { type: K; payload: MutationPayloadMap[K] };
}[MutationType];

export type QueueItem = QueuedMutation & {
  id: string;
  timestamp: number;
  synced: boolean;
  error?: string;
};

const DB_NAME = 'micopay_offline';
const STORE_NAME = 'mutations';
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

/**
 * Initialize IndexedDB connection
 */
export async function initOfflineQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('Failed to open IndexedDB', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      console.log('✅ IndexedDB initialized for offline queue');
      resolve();
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      
      // Create object store if it doesn't exist
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('Created IndexedDB object store:', STORE_NAME);
      }
    };
  });
}

/**
 * Ensure database is initialized
 */
function ensureDb(): IDBDatabase {
  if (!db) {
    throw new Error('IndexedDB not initialized. Call initOfflineQueue() first.');
  }
  return db;
}

/**
 * Add a mutation to the offline queue
 */
export async function queueMutation<T extends MutationType>(
  type: T,
  payload: MutationPayloadMap[T],
): Promise<string> {
  const database = ensureDb();
  const id = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const item = {
    id,
    type,
    payload,
    timestamp: Date.now(),
    synced: false,
  } as QueueItem;

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(item);

    request.onsuccess = () => {
      console.log('✅ Mutation queued:', id, type);
      resolve(id);
    };

    request.onerror = () => {
      console.error('Failed to queue mutation:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get all pending (unsynced) mutations
 */
export async function getPendingMutations(): Promise<QueueItem[]> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('synced');
    const request = index.getAll(IDBKeyRange.only(false)); // false = not synced

    request.onsuccess = () => {
      const items = request.result as QueueItem[];
      resolve(items.sort((a, b) => a.timestamp - b.timestamp));
    };

    request.onerror = () => {
      console.error('Failed to get pending mutations:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get all queued mutations (including synced ones)
 */
export async function getAllMutations(): Promise<QueueItem[]> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = request.result as QueueItem[];
      resolve(items.sort((a, b) => a.timestamp - b.timestamp));
    };

    request.onerror = () => {
      console.error('Failed to get all mutations:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Mark a mutation as successfully synced
 */
export async function markAsSynced(id: string): Promise<void> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const item = request.result as QueueItem | undefined;
      if (item) {
        item.synced = true;
        item.error = undefined;
        const updateRequest = store.put(item);

        updateRequest.onsuccess = () => {
          console.log('✅ Mutation marked as synced:', id);
          resolve();
        };

        updateRequest.onerror = () => {
          console.error('Failed to mark mutation as synced:', updateRequest.error);
          reject(updateRequest.error);
        };
      } else {
        reject(new Error(`Mutation not found: ${id}`));
      }
    };

    request.onerror = () => {
      console.error('Failed to retrieve mutation for sync:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Mark a mutation with an error
 */
export async function markWithError(id: string, error: string): Promise<void> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const item = request.result as QueueItem | undefined;
      if (item) {
        item.error = error;
        const updateRequest = store.put(item);

        updateRequest.onsuccess = () => {
          console.log('⚠️ Mutation marked with error:', id, error);
          resolve();
        };

        updateRequest.onerror = () => {
          reject(updateRequest.error);
        };
      } else {
        reject(new Error(`Mutation not found: ${id}`));
      }
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Remove a mutation from the queue
 */
export async function removeMutation(id: string): Promise<void> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => {
      console.log('✅ Mutation removed from queue:', id);
      resolve();
    };

    request.onerror = () => {
      console.error('Failed to remove mutation:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Clear all mutations from the queue (for cleanup/testing)
 */
export async function clearAllMutations(): Promise<void> {
  const database = ensureDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => {
      console.log('✅ All mutations cleared from queue');
      resolve();
    };

    request.onerror = () => {
      console.error('Failed to clear mutations:', request.error);
      reject(request.error);
    };
  });
}

/**
 * Get count of pending mutations
 */
export async function getPendingMutationCount(): Promise<number> {
  const mutations = await getPendingMutations();
  return mutations.length;
}

/**
 * Check if there are any pending mutations
 */
export async function hasPendingMutations(): Promise<boolean> {
  const count = await getPendingMutationCount();
  return count > 0;
}
