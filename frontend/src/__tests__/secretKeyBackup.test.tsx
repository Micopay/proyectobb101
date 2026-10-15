/**
 * T-12/T-13 · La llave secreta no vuelve al portapapeles.
 *
 * `SecretKeyBackupModal` quedo como el UNICO camino por el que la llave
 * secreta Stellar aparece en pantalla: alta, export desde Perfil y la
 * compuerta previa a la primera operacion con fondos. Esa ultima seguia
 * teniendo su propio modal en App.tsx con un boton "Copiar Llave Secreta"
 * —el defecto que T-12/T-13 arreglo en los otros dos y dejo aqui— y encima
 * copiar marcaba la cuenta como respaldada mientras "Continuar" ejecutaba la
 * operacion pasara lo que pasara.
 *
 * Estos tests fijan las tres propiedades del camino que queda:
 *   1. la llave no pasa por el portapapeles;
 *   2. solo se da por respaldada si el usuario transcribe los ultimos 4;
 *   3. FLAG_SECURE se pone al abrir y se retira al cerrar.
 *
 * Y uno estructural: que no reaparezca un segundo camino que copie la llave.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SecretKeyBackupModal from '../components/SecretKeyBackupModal';

const enable = vi.fn().mockResolvedValue(undefined);
const disable = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/secureScreen', () => ({
  SecureScreen: {
    enable: (...a: unknown[]) => enable(...a),
    disable: (...a: unknown[]) => disable(...a),
  },
}));

const SECRET = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQR9XYZ';
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
});

describe('SecretKeyBackupModal', () => {
  it('muestra la llave sin escribirla en el portapapeles', async () => {
    render(<SecretKeyBackupModal secretKey={SECRET} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /mostrar la llave secreta/i }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();

    // Ni al revelar, ni por un boton de copiar: no lo hay.
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copiar/i)).toBeNull();
  });

  it('no da por respaldada la llave si la transcripcion no coincide', async () => {
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    render(
      <SecretKeyBackupModal secretKey={SECRET} onConfirmed={onConfirmed} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /mostrar la llave secreta/i }));
    fireEvent.change(await screen.findByLabelText(/ultimos 4|últimos 4/i), {
      target: { value: 'XXXX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ya la anot/i }));

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/no coincide/i)).toBeInTheDocument();
  });

  it('la da por respaldada con los ultimos 4 correctos, sin distinguir mayusculas', async () => {
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    render(
      <SecretKeyBackupModal secretKey={SECRET} onConfirmed={onConfirmed} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /mostrar la llave secreta/i }));
    fireEvent.change(await screen.findByLabelText(/ultimos 4|últimos 4/i), {
      target: { value: SECRET.slice(-4).toLowerCase() },
    });
    fireEvent.click(screen.getByRole('button', { name: /ya la anot/i }));

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    // Cierra DESPUES de confirmar, en la misma pulsacion: quien lo use tiene
    // que distinguir las dos ramas o confirmar disparara tambien la de cancelar.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('bloquea capturas mientras esta abierto y las libera al cerrarse', async () => {
    const { unmount } = render(<SecretKeyBackupModal secretKey={SECRET} onClose={() => {}} />);
    await waitFor(() => expect(enable).toHaveBeenCalled());
    expect(disable).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(disable).toHaveBeenCalled());
  });
});

describe('ningun otro camino copia la llave secreta', () => {
  /**
   * Guardia estructural, no de comportamiento: el defecto se colo porque un
   * tercer flujo tenia su propia copia del modal. Recorre las fuentes y falla
   * si `revealSecretKey`/`secretKey` vuelve a acabar en el portapapeles.
   */
  it('no hay writeText sobre material de llave secreta', () => {
    const SRC = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(p);
      }
    };
    walk(SRC);

    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf-8');
      return /clipboard\.writeText\(\s*(secretKey|backupSecret|secret)\b/.test(src);
    });

    expect(offenders.map((f) => f.replace(SRC, ''))).toEqual([]);
  });
});
