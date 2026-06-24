// Measure effect sub-imports
async function time(label, importFn) {
  const start = process.hrtime.bigint();
  try {
    await importFn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ${elapsed.toFixed(2)} ms`);
    return elapsed;
  } catch (e) {
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`  ${label}: ERROR ${e.message.slice(0, 60)}`);
    return elapsed;
  }
}

console.log('=== Effect sub-dependency import times ===\n');

// First, see what effect does on import
// Start with it's direct dependencies
await time('@standard-schema/spec', () => import('@standard-schema/spec'));
await time('fast-check', () => import('fast-check'));
await time('find-my-way-ts', () => import('find-my-way-ts'));
await time('uuid', () => import('uuid'));
await time('yaml', () => import('yaml'));
await time('toml', () => import('toml'));
await time('multipasta', () => import('multipasta'));
await time('msgpackr', () => import('msgpackr'));
await time('kubernetes-types', () => import('kubernetes-types'));
await time('ini (v7)', () => import('ini'));

console.log('\n--- effect itself ---');
await time('effect', () => import('effect'));

console.log('\n--- Check effect main entry ---');
const effectMod = await import('effect');
const exportKeys = Object.keys(effectMod);
console.log(`  effect exports: ${exportKeys.length} items`);
console.log(`  First 10: ${exportKeys.slice(0, 10).join(', ')}`);
