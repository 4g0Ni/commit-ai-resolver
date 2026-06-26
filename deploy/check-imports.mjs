/**
 * Deploy import smoke check.
 *
 * Statically verifies that every RELATIVE import specifier in the packaged
 * JS resolves to a file that exists inside the package. This catches
 * deploy-only ERR_MODULE_NOT_FOUND breakage — e.g. a nested api/agents file
 * importing `../../src/...` that points outside the flattened web root — BEFORE
 * the package ships and crash-loops in production.
 *
 * Usage: node check-imports.mjs <stagingDir>
 * Exits 0 if all relative imports resolve, 1 otherwise.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';

const stagingDir = process.argv[2];
if (!stagingDir) {
    console.error('[check-imports] Missing staging directory argument');
    process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'assets', '.git']);
const CODE_EXT = /\.(js|mjs|cjs)$/;

/** Recursively collect JS files under a directory, skipping vendor/build dirs. */
async function collectFiles(dir) {
    const out = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            out.push(...await collectFiles(join(dir, entry.name)));
        } else if (CODE_EXT.test(entry.name)) {
            out.push(join(dir, entry.name));
        }
    }
    return out;
}

// Match STATIC import/export specifiers only:
//   import x from '...'   |   import '...'   |   export { x } from '...'
// Dynamic import('...') is intentionally NOT checked — it is frequently used
// as an optional/guarded load with a try/catch fallback (e.g. a CLI script
// probing for api/db.js), so a missing target there is not a load-time crash.
// The class of bug this guards against (a hard ESM import that crash-loops the
// process on startup) is always a static import.
const SPEC_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

/** Resolve a relative specifier to an on-disk file the way Node ESM would. */
function resolves(fromFile, spec) {
    const base = resolve(dirname(fromFile), spec);
    const candidates = [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.json`,
        join(base, 'index.js'),
        join(base, 'index.mjs'),
    ];
    return candidates.some(c => existsSync(c));
}

const files = await collectFiles(stagingDir);
const failures = [];

for (const file of files) {
    let content;
    try {
        content = await readFile(file, 'utf-8');
    } catch {
        continue;
    }
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(content)) !== null) {
        const spec = m[1];
        if (!spec) continue;
        // Only relative specifiers; skip bare/package and dynamic-template imports.
        if (!spec.startsWith('.')) continue;
        if (spec.includes('${') || spec.includes('`')) continue;
        if (!resolves(file, spec)) {
            failures.push({ file, spec });
        }
    }
}

if (failures.length > 0) {
    console.error(`[check-imports] ${failures.length} unresolved relative import(s):`);
    for (const f of failures) {
        console.error(`  ${f.file.replace(stagingDir, '.')}  ->  ${f.spec}`);
    }
    process.exit(1);
}

console.log(`[check-imports] OK — ${files.length} files scanned, all relative imports resolve.`);
process.exit(0);
