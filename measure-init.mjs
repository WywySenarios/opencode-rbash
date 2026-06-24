import { loadConfig } from './src/config.ts';
import { initSymlinks } from './src/init.ts';

async function main() {
  const start = Date.now();
  const config = loadConfig({ projectRoot: '/tmp/test' });
  console.log('Config:', Object.keys(config.allow).length, 'executables +', (config.script_interpreters||[]).length, 'interpreters');
  
  const t1 = Date.now();
  
  // Use real system which
  const result = await initSymlinks({
    config,
    projectRoot: '/tmp/perf-test-' + Date.now(),
    resolver: {
      which: async (name) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync('which', [name], { encoding: 'utf-8' });
          return stdout.trim() || null;
        } catch {
          return null;
        }
      }
    }
  });
  
  console.log('initSymlinks duration:', Date.now() - t1, 'ms');
  console.log('Warnings:', result.warnings.length);
  console.log('Writable targets:', result.userWritableTargets.length);
  
  const found = Object.keys(config.allow).length - result.warnings.length;
  console.log('Found executables:', found);
}

main().catch(e => console.error('Error:', e.message));
