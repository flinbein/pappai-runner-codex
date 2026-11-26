import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fork } from 'node:child_process';

async function fixture(t) {
  const {CodexInstallation} = await import('../src/installation.mjs');
  const toolsDir = await mkdtemp(join(tmpdir(), 'runner-tools-'));
  t.after(() => rm(toolsDir, {recursive:true, force:true}));
  const downloads = [];
  const options = {
    toolsDir, latest:async () => '1.2.3',
    async download(dir,version) {
      downloads.push(version);
      if (version === '9.9.9') throw Error('Download failed');
      await mkdir(join(dir,'distribution','bin'), {recursive:true});
      await writeFile(join(dir,'distribution','bin','codex'),version);
    },
    inspect:path => readFile(path,'utf8'),
  };
  return {options, downloads, launch(overrides={}) { return new CodexInstallation({...options,...overrides}); }};
}

test('bootstrap, explicit upgrade and offline restart preserve the selected distribution', async t => {
  const f = await fixture(t), first = f.launch();
  await first.start();
  assert.deepEqual(first.status(),{source:'managed',status:'ready',version:'1.2.3'});
  const previous = await first.executable();
  await first.install('2.0.0');
  assert.equal(await readFile(previous,'utf8'),'1.2.3');
  await assert.rejects(first.install('9.9.9'),/Download failed/);
  assert.equal(await readFile(await first.executable(),'utf8'),'2.0.0');
  assert.equal(first.status().error,'Download failed');
  const next = f.launch({latest:() => assert.fail('No registry lookup on restart')});
  await next.start();
  assert.deepEqual(next.status(),{source:'managed',status:'ready',version:'2.0.0'});
  assert.deepEqual(f.downloads,['1.2.3','2.0.0','9.9.9']);
});

test('a saved managed selection takes precedence over the legacy executable',async t => {
  const f = await fixture(t);
  const configuredPath=join(f.options.toolsDir,'external');
  await writeFile(configuredPath,'0.170.0');
  const first=f.launch({configuredPath});
  await first.start();
  assert.equal(await first.executable(),configuredPath);
  assert.equal(first.status().source,'configured');
  await first.install('1.2.3');
  const second=f.launch({configuredPath});
  await second.start();
  assert.equal(second.status().source,'managed');
  assert.deepEqual(f.downloads,['1.2.3']);
  await assert.rejects(second.install('../bad'),/version/i);
});

test('workers wait for bootstrap, then keep using the active CLI while an update downloads', async t => {
  const f=await fixture(t), first=Promise.withResolvers(), update=Promise.withResolvers();
  const installation=f.launch({async download(stage,version) {
    await (version==='1.2.3' ? first : update).promise;
    await f.options.download(stage,version);
  }});
  const started=installation.start(), worker=installation.executable();
  assert.deepEqual(installation.status(),{source:'managed',status:'installing',version:null});
  first.resolve();
  await started;
  const oldPath=await worker;
  const changing=installation.install('2.0.0');
  assert.equal(installation.status().version,'1.2.3');
  assert.equal(await installation.executable(),oldPath);
  update.resolve();
  await changing;
  assert.equal(await readFile(await installation.executable(),'utf8'),'2.0.0');
});

test('the host announces methods and replies during bootstrap', {timeout:10000}, async t => {
  const native=process.env.PAPPAI_TEST_CODEX_CLI;
  const child = fork(new URL('../src/index.mjs',import.meta.url),[],{
    env:{...process.env,PAPPAI_RUNNER_DIR:'',PAPPAI_RUNNER_CONFIG:JSON.stringify({codexExecutablePath:native}),
      PAPPAI_RUNNER_NAME:'second'},stdio:['ignore','ignore','inherit','ipc'],
  });
  t.after(() => child.kill());
  const ready = await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('Missing runnerReady')),3000);
    child.on('message',msg => { if (msg.type==='runnerReady') {clearTimeout(timer); resolve(msg.payload);} });
  });
  assert.equal(ready.kind,'codex');
  assert.equal(ready.settingsSchema.type,'object');
  assert.deepEqual(Object.keys(ready.methods).sort(),['getVersion','installCodex']);
  assert.equal(ready.profileCli.authorize.version,'1');
  assert.deepEqual(ready.profileCli.authorize.schema.input,{type:'object',properties:{},additionalProperties:false});
  function call(method,data) {
    return new Promise(resolve => {
      const receive = msg => {
        if (msg.type !== 'runnerReply' || msg.payload.id !== method) return;
        child.off('message',receive);
        resolve(msg.payload);
      };
      child.on('message',receive);
      child.send({type:'runnerCall',id:method,method,data});
    });
  }
  assert.equal((await call('getVersion',{})).id,'getVersion');
  assert.match((await call('@cli.prepare',{})).error,/Invalid PROFILE/);
  if (native) {
    const {result} = await call('@cli.prepare',{feature:'authorize',node:'profile-id',input:{}});
    assert.equal(result.files[1],native);
    assert.deepEqual(result.argv.slice(-2),['profile-id','second']);
  }
});
