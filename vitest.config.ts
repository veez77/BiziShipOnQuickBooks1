import { realpathSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// On Windows the working directory can arrive as "c:\..." while the real path is "C:\...".
// Vite then loads the same source file under two module ids, so a class (e.g. an error type)
// exists twice and `instanceof` randomly fails in the full parallel run. Pin one spelling.
export default defineConfig({
  root: realpathSync.native(process.cwd()),
});
