import { BoardError } from './errors.mjs';

const OWNER_ID = 99961;
const fail = () => {
  throw new BoardError('service_unavailable');
};
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);

export function requireProductionContext(context) {
  if (context?.deploy?.context !== 'production')
    throw new BoardError('forbidden');
}

export function requirePublishedDeploy(context) {
  requireProductionContext(context);
  if (context.deploy.published !== true || !identifier(context.deploy.id))
    throw new BoardError('forbidden');
  return context.deploy.id;
}

export function readPublicOrigin(env) {
  try {
    const value = env.BOARD_APP_ORIGIN;
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !url.hostname ||
      (value !== url.origin && value !== `${url.origin}/`)
    )
      fail();
    return url.origin;
  } catch {
    fail();
  }
}

export function requireCanonicalOrigin(request, origin) {
  try {
    if (new URL(request.url).origin !== origin)
      throw new BoardError('forbidden');
  } catch {
    throw new BoardError('forbidden');
  }
}

function decodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) fail();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) fail();
  return key;
}

export function readEnvironment(env) {
  const origin = readPublicOrigin(env);
  if (env.BOARD_OWNER_ID !== String(OWNER_ID)) fail();
  const rawAppId = env.GITHUB_APP_ID;
  if (typeof rawAppId !== 'string' || !/^[1-9]\d*$/.test(rawAppId)) fail();
  const appId = Number(rawAppId);
  if (!Number.isSafeInteger(appId)) fail();
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  if (
    !identifier(clientId) ||
    typeof clientSecret !== 'string' ||
    clientSecret.length < 1 ||
    clientSecret.length > 4096 ||
    /[\r\n\0]/.test(clientSecret)
  )
    fail();
  const keyId = env.BOARD_TOKEN_KEY_ID;
  if (!identifier(keyId)) fail();
  const key = decodeKey(env.BOARD_TOKEN_ENCRYPTION_KEY);
  const previousId = env.BOARD_PREVIOUS_TOKEN_KEY_ID;
  const previousValue = env.BOARD_PREVIOUS_TOKEN_ENCRYPTION_KEY;
  const keys = new Map([[keyId, key]]);
  if (previousId !== undefined || previousValue !== undefined) {
    if (
      !identifier(previousId) ||
      previousId === keyId ||
      previousValue === undefined
    )
      fail();
    keys.set(previousId, decodeKey(previousValue));
  }
  return Object.freeze({
    origin,
    ownerId: OWNER_ID,
    appId,
    clientId,
    clientSecret,
    callbackUrl: `${origin}/api/auth/callback`,
    keyring: Object.freeze({ currentId: keyId, keys }),
  });
}

export function readAnalysisEnvironment(env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (
    typeof apiKey !== 'string' ||
    apiKey.length < 1 ||
    apiKey.length > 4096 ||
    /[\r\n\0]/u.test(apiKey)
  )
    fail();
  return Object.freeze({ apiKey });
}
