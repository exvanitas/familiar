/* The app build's compile-time constants. Named mutation switches (packages/core/src/mutations.ts) fold
   to false here, so their branches, their names and the switches are dropped from every page bundle.
   Under vitest the core project defines it true (packages/core/vitest.config.ts). */
export const APP_DEFINE = { __FAMILIAR_MUTATIONS__: 'false' } as const;

/** The app build's options that drop them: the constant, and syntax folding so a dead branch's body (a
    mutation's state, read only behind the constant) goes too. Identifiers and layout are kept. */
export const APP_BUILD = { define: APP_DEFINE, minifySyntax: true } as const;
