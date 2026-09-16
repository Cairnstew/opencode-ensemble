/**
 * Node resolve hook for test/node-smoke.ts.
 *
 * Node's TypeScript type stripping requires explicit extensions on relative
 * imports, but src/ uses extensionless imports (bundler-style moduleResolution).
 * This hook retries a failed relative resolution with a ".ts" extension so the
 * smoke script can load the real src/ modules under Node without a bundler or
 * an extra dev dependency.
 *
 * Loaded via: node --import ./test/node-smoke-hook.mjs test/node-smoke.ts
 */
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith(".")) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})
