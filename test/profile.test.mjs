import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { profileMethod, profileAuthPath } from '../src/profile.mjs';

test('authorize source through the active call, retain working credentials on invalid import, redact and remove', async t => {
  const profilesDir=await mkdtemp(join(process.platform==='linux'?'/run/pappai/private':tmpdir(),'runner-profile-'));
  t.after(()=>rm(profilesDir,{recursive:true,force:true}));
  const cfg={profilesDir}, id=randomUUID();
  const call=(method,data={},reader)=>profileMethod(cfg,id,method,data,reader);
  const bytes=Buffer.from(JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-only'}));
  assert.deepEqual(await call('status'),{configured:false});
  assert.deepEqual(await call('setup',{authFile:'/tmp/input'},async path=>{assert.equal(path,'/tmp/input');return bytes;}),{configured:true});
  const file=await profileAuthPath(cfg,id);
  assert.deepEqual(await readFile(file),bytes);
  if (process.platform!=='win32') assert.equal((await stat(file)).mode & 0o777,0o600);
  await assert.rejects(call('setup',{authFile:'/tmp/input'},async()=>Buffer.from('{}')),/credential/i);
  await assert.rejects(call('setup',{authFile:'/tmp/input'},async()=>{throw Error('Permission denied');}),/denied/);
  assert.deepEqual(await readFile(file),bytes);
  await call('mcp.set',{name:'tasks',url:'https://example.org/mcp'});
  assert.deepEqual(await call('remove'),{configured:false});
  assert.deepEqual(await call('mcp.get'),{});
  assert.deepEqual(await call('status'),{configured:false});
  await assert.rejects(profileAuthPath(cfg,'../../outside'));
});
