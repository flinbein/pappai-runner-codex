import { readFile } from 'node:fs/promises';
import { profileAuthPath, withProfileLock } from './profile.mjs';

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); }
  catch { return {}; }
}

function loginParams(auth) {
  if ((auth.auth_mode == null || auth.auth_mode === 'apikey') && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
    return {type:'apiKey', apiKey:auth.OPENAI_API_KEY};
  }
  const tokens = auth.tokens;
  if ((auth.auth_mode != null && auth.auth_mode !== 'chatgpt') || typeof tokens?.access_token !== 'string' ||
      typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw Error('Invalid subscription credentials');
  const access = claims(tokens.access_token)['https://api.openai.com/auth'] ?? {};
  const id = claims(tokens.id_token)['https://api.openai.com/auth'] ?? {};
  const account = tokens.account_id ?? access.chatgpt_account_id ?? id.chatgpt_account_id;
  if (typeof account !== 'string' || !account || (access.chatgpt_account_id && access.chatgpt_account_id !== account)) {
    throw Error('Invalid subscription account');
  }
  return {type:'chatgptAuthTokens', accessToken:tokens.access_token, chatgptAccountId:account,
    chatgptPlanType:access.chatgpt_plan_type ?? id.chatgpt_plan_type ?? null};
}

export async function sessionAuth(config, profileId, rotate) {
  const read = async () => {
    const path = await profileAuthPath(config, profileId);
    return {path, login:loginParams(JSON.parse(await readFile(path, 'utf8')))};
  };
  const {login:initial} = await withProfileLock(config, profileId, read);
  const {type,chatgptAccountId} = initial;
  let lastToken;

  function check(login) {
    if (login.type !== type || login.chatgptAccountId !== chatgptAccountId) throw Error('Profile account changed');
  }

  async function latest(expectToken, proactive) {
    return withProfileLock(config, profileId, async () => {
      let {path,login} = await read();
      check(login);
      if (type === 'apiKey') return login;
      const exp = claims(login.accessToken).exp;
      const expired = Number.isFinite(exp) && exp * 1000 <= Date.now() + 30_000;
      if ((proactive && expired) || (!proactive && expectToken === login.accessToken)) {
        const before = login.accessToken;
        // Codex can persist a successful rotation and subsequently reject account/read
        // during workspace discovery. The atomically stored token is authoritative.
        try { await rotate(config, path); } catch { /* verify the persisted result below */ }
        ({login} = await read());
        check(login);
        if (login.accessToken === before) throw Error('Subscription credentials could not be renewed');
      }
      lastToken = login.accessToken;
      return login;
    });
  }

  return {
    getTokens: () => latest(null, true),
    async refreshTokens(params) {
      if (type !== 'chatgptAuthTokens' || params.reason !== 'unauthorized' || !lastToken ||
          (params.previousAccountId != null && params.previousAccountId !== chatgptAccountId)) {
        throw Error('Invalid subscription refresh request');
      }
      const {type:_, ...tokens} = await latest(lastToken, false);
      return tokens;
    },
  };
}
