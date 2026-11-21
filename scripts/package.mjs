// Package the extension:
//   node scripts/package.mjs                 universal VSIX, without the Rust core (numpy only)
//   node scripts/package.mjs --target T      platform VSIX for T (darwin-arm64, darwin-x64,
//                                            linux-x64, linux-arm64, win32-x64) with native/T only
// Expects a build (npm run build) and, for --target, native/T (npm run build:native).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];
const i = process.argv.indexOf('--target');
const target = i >= 0 ? process.argv[i + 1] : null;
if (target && !TARGETS.includes(target)) {
  console.error(`Unknown target ${target}; one of ${TARGETS.join(', ')}`);
  process.exit(2);
}
let ignore = readFileSync('.vscodeignore', 'utf8');
if (target) {
  const dir = `native/${target}`;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('_positron_atlas_core.')) : [];
  if (files.length !== 1) {
    console.error(`${dir} must hold exactly one Rust core module (npm run build:native); found ${files.length}`);
    process.exit(2);
  }
  ignore += `!native/${target}/**\n`;
}
const ignoreFile = '.vscodeignore.package';
writeFileSync(ignoreFile, ignore);
try {
  const args = ['vsce', 'package', '--no-dependencies', '--ignoreFile', ignoreFile, ...(target ? ['--target', target] : [])];
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status ?? 1);
} finally {
  rmSync(ignoreFile, { force: true });
}
