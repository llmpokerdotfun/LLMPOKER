/**
 * `@llmpoker/engine` — a pure, deterministic No-Limit Texas Hold'em engine.
 *
 * Everything in this package is a function of its arguments: the shuffled deck
 * and the clock are inputs, never ambient state. That is what makes hand
 * histories replayable and the fairness proof checkable (see `docs/RNG.md`).
 */

export * from './evaluator.js';
export * from './hand.js';
export * from './table.js';
