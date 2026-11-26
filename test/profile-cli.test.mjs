import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareProfileCli } from '../src/profile-cli.mjs';

const options = {skip:process.platform !== 'linux',timeout:10000};

test('prepare binds the helper and selected executable for the requested registration',async () => {
  const installation = {executable:async () => '/private/native'};
  const data = {feature:'authorize',node:'profile-id',input:{}};
  const plan = await prepareProfileCli(data,installation,'second');
  assert.ok((await lstat(plan.files[0])).isFile());
  assert.deepEqual(plan.files.slice(1),['/private/native']);
  assert.deepEqual(plan.argv,['/usr/local/bin/node','/run/pappai/cli/0','/run/pappai/cli/1','profile-id','second']);
  for (const invalid of [{feature:'unknown'},{input:[]},{input:{file:'/other'}},{node:null},{argv:['/bin/sh']}]) {
    await assert.rejects(prepareProfileCli({...data,...invalid},installation,'second'),/Invalid PROFILE/);
  }
});

async function fixture(t,login) {
  const root = await mkdtemp('/tmp/runner-profile-cli-');
  t.after(() => rm(root,{recursive:true,force:true}));
  const scratch = join(root,'scratch'), stored = join(root,'stored'), calls = join(root,'calls');
  const codex = join(root,'codex'), client = join(root,'client');
  await mkdir(scratch,{mode:0o700});
  await writeFile(stored,'previous');
  const prefix = '#!'+process.execPath+'\n';
  await writeFile(codex,prefix+`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.deepEqual(process.argv.slice(2),['--no-daemon','-c','cli_auth_credentials_store="file"','login','--device-auth']);
    assert.equal(process.env.CODEX_HOME,process.cwd());
    assert.equal(process.env.HOME,process.cwd());
    assert.equal(process.env.OPENAI_API_KEY,undefined);
    assert.equal(process.env.PAPPAI_TERMINAL_SOCKET,undefined);
    fs.writeFileSync('auth.json','fixture-secret');
    `+login,{mode:0o700});
  await writeFile(client,prefix+`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const [op,node,method,json] = process.argv.slice(2);
    assert.equal(op,'call');
    assert.equal(node,'target');
    assert.equal(process.env.PAPPAI_TERMINAL_SOCKET,'fixture-socket');
    fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify([method,JSON.parse(json)])+'\\n');
    if (method === 'second.setup') {
      fs.copyFileSync(JSON.parse(json).authFile,${JSON.stringify(stored)});
    } else {
      assert.equal(method,'second.status');
      console.log('{"configured":true}');
    }`,{mode:0o700});
  const helper = new URL('../src/authorize.mjs',import.meta.url).href;
  const script = `import {authorize} from ${JSON.stringify(helper)}; await authorize(...process.argv.slice(1));`;
  const child = spawn(process.execPath,['--input-type=module','-e',script,codex,'target','second',client],{
    env:{...process.env,PAPPAI_CLI_TMP:scratch,OPENAI_API_KEY:'fixture-host-key',PAPPAI_TERMINAL_SOCKET:'fixture-socket'},
    stdio:['ignore','pipe','pipe'],
  });
  const closed = once(child,'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => { output += chunk; });
  return {child,closed,output:() => output,stored,calls,scratch};
}

test('successful login imports by path, displays status and removes the private home',options,async t => {
  const f = await fixture(t,'');
  assert.deepEqual(await f.closed,[0,null],f.output());
  assert.equal(f.output(),'{"configured":true}\n');
  const lines = (await readFile(f.calls,'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(([method]) => method),['second.setup','second.status']);
  assert.deepEqual(Object.keys(lines[0][1]),['authFile']);
  assert.ok(lines[0][1].authFile.startsWith(f.scratch+'/codex-'));
  assert.ok(lines[0][1].authFile.endsWith('/auth.json'));
  assert.deepEqual(lines[1][1],{});
  assert.equal(await readFile(f.stored,'utf8'),'fixture-secret');
  assert.deepEqual(await readdir(f.scratch),[]);
});

test('cancelling while Codex waits preserves the existing connection and removes pending credentials',options,async t => {
  const f = await fixture(t,'console.log("waiting"); setInterval(() => {},60000)');
  await once(f.child.stdout,'data');
  f.child.kill('SIGTERM');
  assert.notEqual((await f.closed)[0],0);
  assert.doesNotMatch(f.output(),/fixture-secret/);
  assert.equal(await readFile(f.stored,'utf8'),'previous');
  await assert.rejects(lstat(f.calls),{code:'ENOENT'});
  assert.deepEqual(await readdir(f.scratch),[]);
});
