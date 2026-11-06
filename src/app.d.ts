/// <reference types="@sveltejs/kit" />

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
      on?(event: string, cb: (...args: unknown[]) => void): void;
      removeListener?(event: string, cb: (...args: unknown[]) => void): void;
    };
  }
}

export {};
