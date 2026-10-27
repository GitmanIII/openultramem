/**
 * Single source of truth for the plugin version.
 *
 * `test/version.test.ts` asserts this matches `package.json`, so a release can
 * never ship with a stale constant.
 */
export const VERSION = "0.4.1"
