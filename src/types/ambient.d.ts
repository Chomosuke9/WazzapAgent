// Ambient module declarations for production dependencies that ship NO bundled
// types and have NO published `@types/*` package on npm.
//
// Covered here (proof: `node_modules/<dep>/package.json` has no `types`/`typings`
// field AND `npm view @types/<dep>` returns "NOT PUBLISHED"):
//   - node-webpmux  (imported in src/wa/commands/sticker.js)
//
// Deps that genuinely lack bundled types but DO have a published `@types/*`
// package (better-sqlite3, fs-extra, fluent-ffmpeg) are covered by installing
// those `@types/*` dev dependencies instead of hand-writing stubs here, per the
// step's preference for `@types/*` over manual shims.
//
// Deps that already ship their own types (baileys, pino, sharp, axios, dotenv)
// or already have `@types/*` installed (ws) intentionally have NO declaration
// here.

declare module 'node-webpmux';
