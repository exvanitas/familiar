/**
 * True only in the test build (each vitest project's `define`); false in the app build (apps/desktop's
 * scripts/build.ts), where every `__FAMILIAR_MUTATIONS__ && mutant(...)` folds to false and the branch,
 * the mutation's name and the switches themselves are dropped (docs/mcp-design.md 7.2).
 */
declare const __FAMILIAR_MUTATIONS__: boolean;
