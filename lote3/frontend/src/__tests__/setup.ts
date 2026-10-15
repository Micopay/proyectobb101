import '@testing-library/jest-dom';

// Node 26+ does not expose localStorage on globalThis; i18n reads it at import time.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
    writable: true,
    configurable: true,
  });
}

if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = function () {};
}

// Polyfill crypto.getRandomValues for jsdom environment
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
      subtle: {} as SubtleCrypto,
    } as Crypto,
    writable: true,
    configurable: true,
  });
}