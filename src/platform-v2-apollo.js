import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function parseEnvFile(path) {
  const values = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fileEnv = parseEnvFile(envFile);
for (const [key, value] of Object.entries(fileEnv)) {
  process.env[key] = value;
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
    String(fileEnv.STERLING_BOOTSTRAP_OWNER ?? process.env.STERLING_BOOTSTRAP_OWNER ?? '').trim().toLowerCase(),
  );

  if (wantsOwnerBootstrap) {
    const ownerUsername = String(fileEnv.STERLING_OWNER_USERNAME ?? '').trim();
    const ownerPassword = String(fileEnv.STERLING_OWNER_PASSWORD ?? '');
    const ownerDisplayName = String(fileEnv.STERLING_OWNER_DISPLAY_NAME ?? 'Owner / Founder').trim() || 'Owner / Founder';

    if (!ownerUsername || !ownerPassword) {
      throw new Error('STERLING_BOOTSTRAP_OWNER is enabled, but STERLING_OWNER_USERNAME or STERLING_OWNER_PASSWORD is missing from platform-v2/.env.');
    }

    console.log('[Platform V2] One-time Owner bootstrap requested...');
    await run(process.execPath, ['dist/bootstrap-owner.js'], {
      env: {
        ...process.env,
        STERLING_OWNER_USERNAME: ownerUsername,
        STERLING_OWNER_PASSWORD: ownerPassword,
        STERLING_OWNER_DISPLAY_NAME: ownerDisplayName,
      },
    });
    console.log('[Platform V2] Owner bootstrap completed. Remove STERLING_BOOTSTRAP_OWNER and STERLING_OWNER_PASSWORD from .env before the next restart.');
  }

  // The Platform V2 .env is the source of truth for its listener. Apollo/Pterodactyl
  // may inject SERVER_PORT for the generic Node egg; that must not silently override
  // an explicit PORT configured for Platform V2.
  const apiPort = String(fileEnv.PORT ?? process.env.PORT ?? process.env.SERVER_PORT ?? '8200').trim() || '8200';
  const apiEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    HOST: process.env.HOST || '0.0.0.0',
    PORT: apiPort,
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
