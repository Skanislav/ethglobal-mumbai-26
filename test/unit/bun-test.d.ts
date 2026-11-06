// `bun:test` is the runner's own module; its types ship with the bun binary and are
// not in the project's dependency graph, so they are declared here for svelte-check.
declare module 'bun:test' {
  type Fn = (...args: never[]) => unknown;
  export function describe(name: string, body: () => void): void;
  export function it(name: string, body: () => void | Promise<void>): void;
  export function beforeEach(body: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeNull(): void;
    toContain(expected: string): void;
    toHaveLength(n: number): void;
    toBeLessThan(n: number): void;
    toBeInstanceOf(ctor: unknown): void;
    toMatch(pattern: RegExp | string): void;
    toMatchObject(expected: Record<string, unknown>): void;
    toThrow(pattern?: RegExp | string | (new (...args: never[]) => unknown)): void;
    rejects: {
      toThrow(pattern?: RegExp | string | (new (...args: never[]) => unknown)): Promise<void>;
      toMatchObject(o: Record<string, unknown>): Promise<void>;
      toBeInstanceOf(c: unknown): Promise<void>;
    };
    not: {
      toBe(expected: unknown): void;
      toBeNull(): void;
      toContain(expected: string): void;
      toHaveBeenCalled(): void;
      toThrow(pattern?: RegExp | string | (new (...args: never[]) => unknown)): void;
    };
  };
  export const mock: { module(specifier: string, factory: () => Record<string, unknown>): void };
  export type Fn = Fn;
}
