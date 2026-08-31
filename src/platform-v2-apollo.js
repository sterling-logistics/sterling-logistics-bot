import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const platformDir = join(repoRoot, 'platform-v2');
const envFile = join(platformDir, '.env');

if (!existsSync(join(platformDir, 'package.json'))) {
  console.error('[Platform V2] Missing platform-v2/package.json. Check the Git branch and repository checkout.');
  process.exit(1);
}

if (!existsSync(envFile)) {
  console.error(`[Platform V2] Missing environment file: ${envFile}`);
  process.exit(1);
}

try {
  process.loadEnvFile(envFile);
} catch (error) {
  console.error('[Platform V2] Could not load platform-v2/.env:', error);
  process.exit(1);
}

for (const required of ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
  if (!process.env[required]) {
    console.error(`[Platform V2] ${required} is missing from platform-v2/.env`);
    process.exit(1);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: platformDir,
      stdio: 'inherit',
      env: process.env,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

console.log('[Platform V2] Preparing Sterling Platform 2.0 for Apollo...');

try {
  await run('npm', ['install', '--include=dev', '--no-audit', '--no-fund']);
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'migrate']);

  const wantsOwnerBootstrap = ['1', 'true', 'yes'].includes(
    String(process.env.STERLING_BOOTSTRAP_OWNER ?? '').trim().toLowerCase(),
  );

  if (wantsOwnerBootstrap) {
    if (!process.env.STERLING_OWNER_USERNAME || !process.env.STERLING_OWNER_PASSWORD) {
      throw new Error('STERLING_BOOTSTRAP_OWNER is enabled but Owner username/password are missing.');
    }

    console.log('[Platform V2] One-time Owner bootstrap requested...');
    const bootstrapEnv = {
      ...process.env,
      STERLING_OWNER_USERNAME: String(process.env.STERLING_OWNER_USERNAME),
      STERLING_OWNER_PASSWORD: String(process.env.STERLING_OWNER_PASSWORD),
      STERLING_OWNER_DISPLAY_NAME: String(process.env.STERLING_OWNER_DISPLAY_NAME || 'Owner / Founder'),
    };
    await run('npm', ['run', 'bootstrap:owner'], { env: bootstrapEnv });
    console.log('[Platform V2] Owner bootstrap completed. Remove STERLING_BOOTSTRAP_OWNER and STERLING_OWNER_PASSWORD from .env before the next restart.');
  }

  const apiEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    HOST: process.env.HOST || '0.0.0.0',
    PORT: process.env.SERVER_PORT || process.env.PORT || '8200',
  };

  console.log(`[Platform V2] Starting API on ${apiEnv.HOST}:${apiEnv.PORT}...`);

  const api = spawn(process.execPath, ['dist/server.js'], {
    cwd: platformDir,
    stdio: 'inherit',
    env: apiEnv,
  });

  const stop = (signal) => {
    if (!api.killed) api.kill(signal);
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  api.on('error', (error) => {
    console.error('[Platform V2] API process error:', error);
    process.exit(1);
  });

  api.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[Platform V2] API stopped by ${signal}.`);
      process.exit(0);
    }
    process.exit(code ?? 1);
  });
} catch (error) {
  console.error('[Platform V2] Startup failed:', error);
  process.exit(1);
}
