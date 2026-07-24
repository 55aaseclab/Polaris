#!/usr/bin/env node
/**
 * Create and manage a persistent login session for Right Code, then create API keys.
 *
 * This script uses the public web application's API endpoints.  It deliberately
 * never stores your password.  The persisted session contains a bearer token, so
 * keep its file private (this script creates it with mode 0600).
 *
 * Examples:
 *   RIGHTCODE_USERNAME=alice RIGHTCODE_PASSWORD='…' node rightcode-api-key.mjs login
 *   node rightcode-api-key.mjs create --name codex-local
 *   RIGHTCODE_USERNAME=alice RIGHTCODE_PASSWORD='…' node rightcode-api-key.mjs create --login --name codex-local
 *
 * Optional login values:
 *   RIGHTCODE_OTP=123456                 # required if your account has 2FA
 *   RIGHTCODE_TURNSTILE_TOKEN='…'        # required only if the site enables Turnstile
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_ORIGIN = 'https://www.right.codes';
const DEFAULT_STATE = resolve(
  process.env.XDG_STATE_HOME || process.env.HOME || process.cwd(),
  process.env.XDG_STATE_HOME ? 'rightcode/session.json' : '.local/state/rightcode/session.json',
);

function usage(exitCode = 0) {
  const text = `
Usage:
  node rightcode-api-key.mjs login [options]
  node rightcode-api-key.mjs create --name NAME [options]
  node rightcode-api-key.mjs update --id ID [options]

Commands:
  login                         Sign in and save a reusable web-session token.
  create                        Create an API key using the saved session.
  update                        Update limits or access scope of an existing API key.

Shared options:
  --site URL                    Site origin (default: ${DEFAULT_ORIGIN})
  --state PATH                  Session file (default: ${DEFAULT_STATE})
  --username USER               Or RIGHTCODE_USERNAME (login only)
  --password PASSWORD           Or RIGHTCODE_PASSWORD (login only)
  --otp CODE                    Or RIGHTCODE_OTP; needed with 2FA
  --turnstile-token TOKEN       Or RIGHTCODE_TURNSTILE_TOKEN if Turnstile is enabled

Create options:
  --login                       Log in before creating, refreshing the saved session.
  --name NAME                   API-key name (required)
  --quota-limit NUMBER          Per-key maximum usage; omit for no per-key limit.
  --allow-wallet BOOL           Allow balance billing (default: true).
  --allowed-item-ids 1,2        Restrict to subscription/package IDs.
  --allowed-prefixes /codex,... Restrict API gateway prefixes.
  --allowed-models gpt-5,...    Restrict models.
  --expires-at ISO_DATE         Set expiry, e.g. 2026-12-31T23:59:59Z.
  --json                        Print structured JSON rather than just the new key.

Update options:
  --id ID                       Existing API-key ID (required).
  --name NAME                   Rename the key.
  --quota-limit NUMBER          Set the per-key maximum usage.
  --allow-wallet BOOL           Enable/disable balance billing.
  --allowed-item-ids 1,2        Replace allowed subscription/package IDs.
  --allowed-prefixes /codex,... Replace allowed API gateway prefixes.
  --allowed-models gpt-5,...    Replace allowed models.
  --expires-at ISO_DATE         Set expiry; use --expires-at never to remove it.

Security:
  Passwords are never persisted. The session file contains a login bearer token
  and is written with mode 0600. The newly created API key is printed only once;
  save it in a secrets manager rather than source code or shell history.
`;
  console[exitCode ? 'error' : 'log'](text.trim());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  const bools = new Set(['login', 'json']);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inlineValue] = arg.slice(2).split('=', 2);
    if (rawName === 'no-allow-wallet') {
      options.allowWallet = false;
      continue;
    }
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      options[name] = inlineValue;
    } else if (name === 'allowWallet') {
      const next = rest[i + 1];
      if (next && /^(true|false|1|0|yes|no)$/i.test(next)) {
        options[name] = next;
        i += 1;
      } else {
        options[name] = true;
      }
    } else if (bools.has(name)) {
      options[name] = true;
    } else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`);
      options[name] = value;
    }
  }
  return { command, options };
}

function value(options, name, envName) {
  return options[name] ?? (envName ? process.env[envName] : undefined);
}

function normalizeOrigin(input) {
  const url = new URL(input || DEFAULT_ORIGIN);
  if (url.protocol !== 'https:') throw new Error('Only an https --site URL is accepted.');
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function parseCsv(input, { numeric = false } = {}) {
  if (input === undefined || input === '') return undefined;
  const values = input.split(',').map((item) => item.trim()).filter(Boolean);
  if (numeric) {
    const ids = values.map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('--allowed-item-ids must be a comma-separated list of positive integers.');
    }
    return ids;
  }
  return values;
}

async function request(origin, path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Network request to ${path} failed: ${error.message}`);
  }
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = data?.message || data?.detail || data?.error || raw || response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
  return data;
}

async function listKeys(origin, token) {
  const result = await request(origin, '/api-key/list', { token });
  const keys = result?.keys ?? result?.items ?? [];
  return Array.isArray(keys) ? keys : [];
}

async function saveSession(statePath, session) {
  const absolute = resolve(statePath);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await chmod(dirname(absolute), 0o700);
  await writeFile(absolute, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(absolute, 0o600);
  return absolute;
}

async function loadSession(statePath) {
  const absolute = resolve(statePath);
  let session;
  try {
    session = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No saved session at ${absolute}. Run the login command first, or add --login with credentials.`);
    }
    throw new Error(`Could not read session file ${absolute}: ${error.message}`);
  }
  if (!session?.token || typeof session.token !== 'string') {
    throw new Error(`Session file ${absolute} does not contain a token.`);
  }
  return { ...session, statePath: absolute };
}

function hasLoginCredentials(options) {
  return Boolean(
    value(options, 'username', 'RIGHTCODE_USERNAME')
      && value(options, 'password', 'RIGHTCODE_PASSWORD'),
  );
}

async function login(origin, statePath, options) {
  const username = value(options, 'username', 'RIGHTCODE_USERNAME');
  const password = value(options, 'password', 'RIGHTCODE_PASSWORD');
  const otp = value(options, 'otp', 'RIGHTCODE_OTP');
  const turnstileToken = value(options, 'turnstileToken', 'RIGHTCODE_TURNSTILE_TOKEN');
  if (!username || !password) {
    throw new Error('Login needs --username/--password, or RIGHTCODE_USERNAME and RIGHTCODE_PASSWORD.');
  }
  const payload = { username, password };
  if (otp) payload.otp_code = otp;
  if (turnstileToken) payload.turnstile_token = turnstileToken;
  const result = await request(origin, '/auth/login', { method: 'POST', body: payload });
  const token = result?.user_token ?? result?.userToken;
  if (!token) {
    if (result?.otp_required) throw new Error('This account requires 2FA. Re-run with --otp or RIGHTCODE_OTP.');
    throw new Error('Login succeeded but did not return user_token/userToken. A Turnstile token may be required.');
  }
  const me = await request(origin, '/auth/me', { token });
  const savedPath = await saveSession(statePath, {
    version: 1,
    origin,
    token,
    username: me?.username ?? username,
    savedAt: new Date().toISOString(),
  });
  console.error(`Authenticated as ${me?.username ?? username}; saved private session to ${savedPath}`);
  return { token, user: me, statePath: savedPath };
}

async function createKey(origin, token, options) {
  const name = value(options, 'name');
  if (!name?.trim()) throw new Error('Creating a key requires --name NAME.');
  const normalizedName = name.trim();
  const quotaText = value(options, 'quotaLimit');
  let quotaLimit;
  if (quotaText !== undefined) {
    quotaLimit = Number(quotaText);
    if (!Number.isFinite(quotaLimit) || quotaLimit < 0) throw new Error('--quota-limit must be a non-negative number.');
  }
  const allowWalletText = options.allowWallet;
  const allowWallet = allowWalletText === undefined ? true : !['false', '0', 'no'].includes(String(allowWalletText).toLowerCase());
  const allowedItemIds = parseCsv(options.allowedItemIds, { numeric: true });
  const existing = (await listKeys(origin, token)).find((key) => String(key?.name ?? '').trim() === normalizedName);
  if (existing) {
    return {
      ...existing,
      id: existing.id,
      name: normalizedName,
      existing: true,
    };
  }
  const created = await request(origin, '/api-key/create', {
    method: 'POST',
    token,
    body: {
      name: normalizedName,
      quota_limit: quotaLimit ?? null,
      allow_wallet: allowWallet,
      allowed_item_ids: allowedItemIds?.length ? allowedItemIds : null,
    },
  });
  const keyId = created?.id;
  if (!keyId) throw new Error('The create endpoint returned no key ID. No follow-up restrictions were applied.');

  const allowedPrefixes = parseCsv(options.allowedPrefixes);
  const allowedModels = parseCsv(options.allowedModels);
  if (allowedPrefixes?.length || allowedModels?.length) {
    await request(origin, `/api-key/${encodeURIComponent(keyId)}`, {
      method: 'PATCH', token,
      body: {
        ...(allowedPrefixes?.length ? { allowed_prefixes: allowedPrefixes } : {}),
        ...(allowedModels?.length ? { allowed_models: allowedModels } : {}),
      },
    });
  }
  if (options.expiresAt) {
    const date = new Date(options.expiresAt);
    if (Number.isNaN(date.getTime())) throw new Error('--expires-at must be a valid ISO 8601 date/time.');
    await request(origin, `/api-key/${encodeURIComponent(keyId)}/expire`, {
      method: 'PATCH', token, body: { expired_at: date.toISOString() },
    });
  }
  return { ...created, id: keyId, name: normalizedName, existing: false };
}

async function updateKey(origin, token, options) {
  const id = Number(options.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Updating a key requires a positive integer --id.');
  const body = {};
  if (options.name !== undefined) {
    if (!options.name.trim()) throw new Error('--name cannot be empty.');
    body.name = options.name.trim();
  }
  if (options.quotaLimit !== undefined) {
    const quota = Number(options.quotaLimit);
    if (!Number.isFinite(quota) || quota < 0) throw new Error('--quota-limit must be a non-negative number.');
    body.quota_limit = quota;
  }
  if (options.allowWallet !== undefined) {
    body.allow_wallet = !['false', '0', 'no'].includes(String(options.allowWallet).toLowerCase());
  }
  if (options.allowedItemIds !== undefined) body.allowed_item_ids = parseCsv(options.allowedItemIds, { numeric: true }) || [];
  if (options.allowedPrefixes !== undefined) body.allowed_prefixes = parseCsv(options.allowedPrefixes) || [];
  if (options.allowedModels !== undefined) body.allowed_models = parseCsv(options.allowedModels) || [];
  if (!Object.keys(body).length && options.expiresAt === undefined) {
    throw new Error('Provide at least one value to update.');
  }
  if (Object.keys(body).length) {
    await request(origin, `/api-key/${encodeURIComponent(id)}`, { method: 'PATCH', token, body });
  }
  if (options.expiresAt !== undefined) {
    const expiredAt = options.expiresAt === 'never' ? null : new Date(options.expiresAt);
    if (expiredAt !== null && Number.isNaN(expiredAt.getTime())) throw new Error('--expires-at must be ISO 8601 or "never".');
    await request(origin, `/api-key/${encodeURIComponent(id)}/expire`, {
      method: 'PATCH', token, body: { expired_at: expiredAt?.toISOString() ?? null },
    });
  }
  return { keys: await listKeys(origin, token) };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') usage();
  if (!['login', 'create', 'update'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const origin = normalizeOrigin(value(options, 'site', 'RIGHTCODE_SITE'));
  const statePath = value(options, 'state', 'RIGHTCODE_STATE_FILE') || DEFAULT_STATE;
  if (command === 'login') {
    await login(origin, statePath, options);
    return;
  }
  let token;
  if (options.login) {
    token = (await login(origin, statePath, options)).token;
  } else {
    try {
      const session = await loadSession(statePath);
      if (session.origin !== origin) throw new Error(`Saved session belongs to ${session.origin}, not ${origin}. Use --state for that session or add --login.`);
      await request(origin, '/auth/me', { token: session.token });
      token = session.token;
    } catch (error) {
      if (!hasLoginCredentials(options)) {
        throw error;
      }
      token = (await login(origin, statePath, options)).token;
    }
  }
  if (command === 'update') {
    const result = await updateKey(origin, token, options);
    const keys = result?.keys ?? result?.items ?? [];
    const updated = Array.isArray(keys) ? keys.find((key) => Number(key?.id) === Number(options.id)) : null;
    console.log(JSON.stringify({ id: Number(options.id), updated: updated ?? true }, null, 2));
    return;
  }
  const key = await createKey(origin, token, options);
  const secret = key.key ?? key.api_key ?? key.token;
  if (options.json) {
    console.log(JSON.stringify({ id: key.id, name: key.name, apiKey: secret ?? null, existing: Boolean(key.existing) }, null, 2));
  } else if (secret) {
    console.log(secret);
  } else if (key.existing) {
    console.error(`Reused existing API key '${key.name}' (ID ${key.id}); plaintext key is not returned by the list endpoint.`);
  } else {
    console.error(`Created key ID ${key.id}, but the API did not return its plaintext key. Open /api-keys to retrieve or rotate it.`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
