// The single reactive session. Svelte 5 permits `export const x = $state(...)`
// from a `.svelte.ts` module but never an exported `$derived`; derived values are
// exported as functions.
//
// `setSession` is the only mutation point, so persistence lives there: every
// state change is written once, and no component needs an effect to save.

import { decodeSession, encodeSession, normalizeSignerAvailability, newSession } from './session';
import type { Session, SessionMode } from './session';

export const STORAGE_KEY = 'sso.session.v1';
export const STEP_KEY = 'sso.step.v1';
/**
 * The step a reload resumes at. The create flow runs to index 6 (its send path);
 * a value outside 0..6 — including one written by an older 5-step build — is
 * rejected, and the caller decides where such a session belongs.
 */
export function loadStep(): number {
  try {
    const raw = localStorage.getItem(STEP_KEY);
    const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : -1;
  } catch {
    return -1;
  }
}

export function saveStep(step: number): void {
  try {
    localStorage.setItem(STEP_KEY, String(step));
  } catch {
    // Step persistence is a convenience; a blocked store must not break navigation.
  }
}

export const session = $state<{ current: Session }>({ current: newSession('create') });

export function setSession(next: Session): void {
  session.current = next;
  try {
    // Same encoding as the exported blob: one canonical format means the stored
    // value and a session file are interchangeable, and there is one decoder to test.
    localStorage.setItem(STORAGE_KEY, encodeSession(next));
  } catch {
    // A full or blocked localStorage must not break the wizard.
  }
}

export function loadFromStorage(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    session.current = normalizeSignerAvailability(decodeSession(raw));
  } catch (err) {
    console.warn('discarding stored session', err);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is unavailable; the in-memory session is already fresh.
    }
  }
}

export function signerCount(): number {
  return session.current.signers.length;
}

export function canPredict(): boolean {
  const s = session.current;
  return s.signers.length > 0 && s.threshold >= 1 && s.threshold <= s.signers.length;
}

export function signableCount(): number {
  return session.current.signers.filter((s) => s.canSign).length;
}

export function mode(): SessionMode {
  return session.current.mode;
}
