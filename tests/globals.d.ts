// The test runner's globals, which the engine's declarations leave out.
declare const console: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
declare function setTimeout<A>(run: (value: A) => void, ms?: number): unknown
declare function clearTimeout(timer: unknown): void
