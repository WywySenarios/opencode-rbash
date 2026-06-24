// Timing script - run from the plugin directory
async function time(label, importFn) {
  const start = process.hrtime.bigint();
  try {
    await importFn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ${elapsed.toFixed(2)} ms`);
    return elapsed;
  } catch (e) {
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ERROR after ${elapsed.toFixed(2)}ms - ${e.message.slice(0, 80)}`);
    return elapsed;
  }
}

console.log('=== Vendor import timings ===\n');

console.log('--- Core vendors ---');
await time('zod', () => import('zod'));
await time('cross-spawn', () => import('cross-spawn'));
await time('@opencode-ai/sdk', () => import('@opencode-ai/sdk'));
await time('@opencode-ai/plugin', () => import('@opencode-ai/plugin'));
await time('@opencode-ai/plugin/tool', () => import('@opencode-ai/plugin/tool'));

console.log('\n--- effect framework (large) ---');
await time('effect', () => import('effect'));

console.log('\n--- plugin config module (.ts) ---');
await time('config.ts', () => import('./src/config.ts'));

console.log('\n--- init module (.ts) ---');
await time('init.ts', () => import('./src/init.ts'));

console.log('\n--- validate module (.ts, 704 lines) ---');
await time('validate.ts', () => import('./src/validate.ts'));

console.log('\n--- FULL plugin import (index.ts) ---');
await time('index.ts', () => import('./src/index.ts'));

console.log('\n--- plugin() function call ---');
const pluginMod = await import('./src/index.ts');
const tStart = process.hrtime.bigint();
const result = pluginMod.default({ worktree: '/tmp/test-project', directory: '/tmp/test-project' });
const tSync = Number(process.hrtime.bigint() - tStart) / 1e6;
console.log(`  plugin() sync part: ${tSync.toFixed(2)} ms`);

await result;
const tAsync = Number(process.hrtime.bigint() - tStart) / 1e6;
console.log(`  plugin() total (async): ${tAsync.toFixed(2)} ms`);

console.log('\nDone.');
