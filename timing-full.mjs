// Full cold-start timing for the plugin
// All imports are fresh - measured individually and as a chain

async function time(label, importFn) {
  const start = process.hrtime.bigint();
  try {
    const mod = await importFn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ${elapsed.toFixed(2)} ms`);
    return { elapsed, mod };
  } catch (e) {
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ERROR ${e.message.slice(0, 80)}`);
    return { elapsed, mod: null };
  }
}

console.log('=== Plugin Cold-Start Import Chain ===\n');

console.log('Phase 1: Direct vendor deps');
const r1 = await time('zod', () => import('zod'));

console.log('\nPhase 2: @opencode-ai/plugin chain');
const r2 = await time('@opencode-ai/plugin', () => import('@opencode-ai/plugin'));

console.log('\nPhase 3: Local TypeScript files');
const r3 = await time('config.ts', () => import('./src/config.ts'));
const r4 = await time('validate.ts', () => import('./src/validate.ts'));
const r5 = await time('init.ts', () => import('./src/init.ts'));
const r6 = await time('execute.ts', () => import('./src/execute.ts'));
const r7 = await time('scripts.ts', () => import('./src/scripts.ts'));
const r8 = await time('agent-auth.ts', () => import('./src/agent-auth.ts'));
const r9 = await time('write-lock.ts', () => import('./src/write-lock.ts'));

console.log('\nPhase 4: What if index.ts could be loaded via import()?');
console.log('(requires tsx or similar for .js→.ts resolution)');

console.log('\nPhase 5: Verify effect is the heaviest');
// Check what the @opencode-ai/plugin actually uses
const pluginMod = r2.mod;
if (pluginMod) {
  console.log(`  @opencode-ai/plugin exports: ${Object.keys(pluginMod).length}`);
}

// Check effect size
const effectMod = await import('effect');
console.log(`  effect exports: ${Object.keys(effectMod).length}`);

console.log('\n--- Summary ---');
const vendorTotal = (r1?.elapsed ?? 0) + (r2?.elapsed ?? 0);
const localTotal = (r3?.elapsed ?? 0) + (r4?.elapsed ?? 0) + (r5?.elapsed ?? 0) + 
                   (r6?.elapsed ?? 0) + (r7?.elapsed ?? 0) + (r8?.elapsed ?? 0) + (r9?.elapsed ?? 0);
console.log(`  Vendor imports: ${vendorTotal.toFixed(2)} ms`);
console.log(`  Local modules:  ${localTotal.toFixed(2)} ms`);
console.log(`  Known total:    ${(vendorTotal + localTotal).toFixed(2)} ms`);
console.log(`  (does not include the .js→.ts resolution issue for index.ts)`);
