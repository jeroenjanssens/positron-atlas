import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode', 'positron'],
  logLevel: 'info',
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
