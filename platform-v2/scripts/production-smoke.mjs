const baseUrl = (process.env.STERLING_SMOKE_URL ?? 'http://127.0.0.1:8200').replace(/\/$/, '');
const username = process.env.STERLING_OWNER_USERNAME;
const password = process.env.STERLING_OWNER_PASSWORD;

if (!username || !password) throw new Error('STERLING_OWNER_USERNAME and STERLING_OWNER_PASSWORD are required.');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function expectStatus(path, expected, options = {}) {
  const result = await request(path, options);
  if (result.response.status !== expected) {
    throw new Error(`${path} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

const health = await expectStatus('/api/v2/health', 200);
if (health?.status !== 'ok' || health?.database !== 'up') {
  throw new Error(`Health check was not fully healthy: ${JSON.stringify(health)}`);
}

await expectStatus('/api/v2/owner/system', 401);
await expectStatus('/api/v2/definitely-not-a-route', 404);

const login = await expectStatus('/api/v2/auth/login', 200, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password })
});

if (!login?.accessToken || login?.user?.role !== 'owner') {
  throw new Error(`Owner login did not return an Owner session: ${JSON.stringify(login)}`);
}

const system = await expectStatus('/api/v2/owner/system', 200, {
  headers: { authorization: `Bearer ${login.accessToken}` }
});

if (system?.api !== 'online' || system?.database !== 'online') {
  throw new Error(`Owner system endpoint failed readiness: ${JSON.stringify(system)}`);
}

console.log('STERLING PRODUCTION SMOKE: PASS');
console.log(JSON.stringify({ health, system }, null, 2));
