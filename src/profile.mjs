import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { mcpMethod } from './http-mcp.mjs';
const methods = ['setup','status','remove','mcp.get','mcp.set','mcp.delete'];
const maxBytes = 1024 * 1024;
const profileOperations = new Map();

// The controller gives one runner host ownership of its profile storage. Configure,
// remove, and native token rotation share the same queue, including errors.
export function withProfileLock(config, id, work) {
  const key = JSON.stringify([config.profilesDir ?? process.env.PAPPAI_PROFILES_DIR, id]);
  const previous = profileOperations.get(key) ?? Promise.resolve();
  const operation = previous.then(work);
  const settled = operation.catch(() => {});
  profileOperations.set(key, settled);
  settled.then(() => { if (profileOperations.get(key) === settled) profileOperations.delete(key); });
  return operation;
}

async function directory(config, id, create) {
  const root = config.profilesDir ?? process.env.PAPPAI_PROFILES_DIR ?? '/run/pappai/private/profiles';
  if (typeof root !== 'string' || !isAbsolute(root) || root !== resolve(root)) throw Error('Invalid profiles directory');
  if (process.platform === 'linux' && !root.startsWith('/run/pappai/private/')) throw Error('Profiles must use the private mount');
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid profile ID');
  // The operator provisions the canonical root. Never follow a tenant-chosen link.
  if (await realpath(root) !== root) throw Error('Invalid profiles directory');
  let dir = root;
  for (const part of [id,'codex']) {
    dir = join(dir,part);
    if (create) {
      try { await mkdir(dir,{mode:0o700}); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw Error('Invalid profile directory');
  }
  return dir;
}
export { directory as profileDirectory };

export async function profileAuthPath(config, id) {
  const path = join(await directory(config,id,false), 'auth.json');
  const s = await lstat(path);
  if (!s.isFile() || s.size > maxBytes || await realpath(path) !== path) throw Error('Invalid profile credentials');
  return path;
}

function validateCredentials(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw Error('Invalid Codex credentials');
  let auth;
  try { auth=JSON.parse(bytes.toString('utf8')); } catch { throw Error('Invalid Codex credentials'); }
  const nonempty = value => typeof value==='string' && value.length>0;
  if (!auth || !(nonempty(auth.OPENAI_API_KEY) || (nonempty(auth.tokens?.access_token) &&
      nonempty(auth.tokens?.refresh_token)))) throw Error('Invalid Codex credentials');
}

export function profileMethod(config, id, method, data, reader) {
  return withProfileLock(config, id, () => runProfileMethod(config,id,method,data,reader));
}

async function runProfileMethod(config, id, method, data, reader) {
  if (method.startsWith('mcp.')) return mcpMethod(config,id,method,data,reader);
  if (method==='status') {
    try { await profileAuthPath(config,id); return {configured:true}; }
    catch (e) { if (e.code==='ENOENT') return {configured:false}; throw e; }
  }
  if (method==='remove') {
    try {
      const dir=await directory(config,id,false);
      const retired=join(dir,'..','codex-removed-'+randomUUID());
      await rename(dir,retired);
      await rm(retired,{recursive:true,force:true});
    }
    catch (e) { if (e.code!=='ENOENT') throw e; }
    return {configured:false};
  }
  if (method!=='setup') throw Error('Unknown profile method');
  if (typeof data?.authFile!=='string' || !data.authFile.startsWith('/') || Object.keys(data).length!==1)
    throw Error('Expected an absolute authFile in the caller file view');
  const bytes=await reader(data.authFile);
  validateCredentials(bytes);
  const dir=await directory(config,id,true);
  const temp=join(dir,randomUUID()+'.tmp');
  const file=await open(temp,constants.O_EXCL|constants.O_CREAT|constants.O_WRONLY,0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp,join(dir,'auth.json'));
  } finally { await rm(temp,{force:true}); }
  return {configured:true};
}

export function attachProfileMethods() {
  const config=JSON.parse(process.env.PAPPAI_RUNNER_CONFIG || '{}');
  const requests=new Map();
  const send=(type,payload)=>{ if (process.connected) process.send({type,payload},()=>{}); };
  function read(id,path) {
    const requestId=randomUUID();
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{requests.delete(requestId);reject(Error('Profile read timed out'));},25_000);
      timeout.unref();
      requests.set(requestId,{id,resolve,reject,timeout});
      send('profileRead',{id,requestId,path});
    });
  }
  process.on('message',msg=>{
    if (msg?.type==='profileFile') {
      const req=requests.get(msg.requestId);
      if (!req || req.id!==msg.id) return;
      clearTimeout(req.timeout);
      requests.delete(msg.requestId);
      if (msg.error) req.reject(Error('Access denied or file unavailable'));
      else req.resolve(Buffer.from(msg.content,'base64'));
    }
    if (msg?.type!=='profileCall' || !methods.includes(msg.method)) return;
    const operation=profileMethod(config,msg.profileId,msg.method,msg.data,path=>read(msg.id,path));
    operation.then(result=>send('profileReply',{id:msg.id,result}),err=>{
      const message = err.code ? 'Profile storage unavailable' : err.message;
      send('profileReply',{id:msg.id,error:message});
    });
  });
  send('profileMethods',{methods});
}
