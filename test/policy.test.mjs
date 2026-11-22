import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { AppServer } from '../src/client.mjs';
import { prepareWorker, rotateProfile } from '../src/policy.mjs';
import { sessionAuth } from '../src/session-auth.mjs';
import { dynamicTools } from '../src/tools.mjs';

test('launch requires a Linux namespace and an explicit profile', async () => {
  await assert.rejects(prepareWorker({}, {}), /Linux bubblewrap|Invalid Codex worker assignment/);
});

test('isolated CLI runs Code Mode with APP tools and resumes its thread', {
  skip: !process.env.PAPPAI_TEST_CODEX_CLI || process.platform !== 'linux', timeout: 45_000,
}, async t => {
  const privateRoot = '/run/pappai/private';
  await mkdir(privateRoot, {recursive:true, mode:0o700});
  const root = await mkdtemp(join(privateRoot, 'policy-test-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const profileId = randomUUID();
  const profilesDir = join(root, 'profiles');
  const profileDir = join(profilesDir, profileId, 'codex');
  await mkdir(profileDir, {recursive:true, mode:0o700});
  const token = 'fixture-' + randomUUID();
  await writeFile(join(profileDir, 'auth.json'), JSON.stringify({OPENAI_API_KEY:token}), {mode:0o600});
  let requestedTools, codeModeOutput;
  const fixture = createServer(async (req,res) => {
    if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    const first = requestedTools === undefined;
    requestedTools = request.tools;
    if (!first) codeModeOutput = request.input.find(item => item.type === 'custom_tool_call_output')?.output;
    const item = first ? {type:'custom_tool_call',id:'ct_1',call_id:'call_1',name:'exec',status:'completed',
      input:'text({names:ALL_TOOLS.map(t=>t.name).sort(),dir:await tools.pappai_dir({}),process:typeof process,fetch:typeof fetch});'}
      : {type:'message',id:'msg_test',role:'assistant',status:'completed',
      content:[{type:'output_text',text:'ready',annotations:[]}]};
    const responseId = first ? 'resp_tool' : 'resp_test';
    const events = [
      {type:'response.created',response:{id:responseId}},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id:responseId,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
    ];
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const config = {codexExecutablePath:process.env.PAPPAI_TEST_CODEX_CLI, profilesDir,
    stateDir:join(root, 'state'), modelBaseUrl:`http://127.0.0.1:${fixture.address().port}/v1`};
  const job = {profileId, appId:randomUUID(), mode:'persistent', sandbox:{read:['/'],write:['/'],network:true}};
  const options = await prepareWorker(config,job);
  t.after(options.cleanup);
  const rpc = new AppServer(options, () => {}, ({tool,arguments:args}) => {
    assert.equal(tool, 'pappai_dir');
    assert.deepEqual(args, {});
    return {success:true,contentItems:[{type:'inputText',text:'visible-node'}]};
  });
  let threadId;
  try {
    await rpc.initialize();
    const {thread} = await rpc.rpc('thread/start', {...options.threadParams, model:'gpt-5.4', dynamicTools});
    threadId = thread.id;
    const result = await rpc.turn({threadId:thread.id,input:[{type:'text',text:'Ready?'}]}, () => {});
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'ready');
    assert.ok(Array.isArray(requestedTools));
    const tools = requestedTools.map(tool => tool.name ?? tool.type);
    const workspaceTools = dynamicTools.map(tool => tool.name).sort();
    assert.ok(tools.includes('exec'));
    assert.deepEqual(tools.filter(name => !['exec','wait','update_plan','request_user_input',...workspaceTools].includes(name)), []);
    const output = codeModeOutput?.find(part => part.text?.startsWith('{'));
    assert.deepEqual(JSON.parse(output.text), {names:workspaceTools,dir:'visible-node',process:'undefined',fetch:'undefined'});
  } finally {
    await rpc.close();
  }
  const restored = await prepareWorker(config,job);
  t.after(restored.cleanup);
  const next = new AppServer(restored, () => {});
  try {
    await next.initialize();
    const {thread} = await next.rpc('thread/resume', {...restored.threadParams, threadId});
    assert.equal(thread.id, threadId);
    assert.match(JSON.stringify(thread.turns), /Ready\?/);
  } finally { await next.close(); }
});

test('two subscription workers share a single native refresh and receive only external access tokens', {
  skip: !process.env.PAPPAI_TEST_CODEX_CLI || process.platform !== 'linux', timeout:45_000,
}, async t => {
  const root = '/run/pappai/private';
  await mkdir(root,{recursive:true,mode:0o700});
  const dir = await mkdtemp(join(root,'auth-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const config = {codexExecutablePath:process.env.PAPPAI_TEST_CODEX_CLI, stateDir:join(dir,'state'), profilesDir:join(dir,'profiles')};
  const profileId = randomUUID(), account = randomUUID();
  const path = join(config.profilesDir, profileId, 'codex');
  await mkdir(path,{recursive:true,mode:0o700});
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = generation => `${encode({alg:'none'})}.${encode({email:'fixture@example.invalid',gen:generation,
    exp:Math.floor(Date.now()/1000)+600, 'https://api.openai.com/auth':{chatgpt_account_id:account,chatgpt_plan_type:'plus'}})}.fixture`;
  const original = jwt(1), renewed = jwt(2);
  await writeFile(join(path,'auth.json'), JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,
    last_refresh:new Date().toISOString(), tokens:{id_token:original,access_token:original,refresh_token:'refresh-original',account_id:account}}), {mode:0o600});
  let exchanges = [];
  const issuer = createServer(async (req,res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    exchanges.push(body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)));
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id_token:renewed,access_token:renewed,refresh_token:'refresh-next'}));
  });
  issuer.listen(0,'127.0.0.1');
  await once(issuer,'listening');
  t.after(() => {issuer.closeAllConnections();issuer.close();});
  const rotate = (config,path) => rotateProfile(config,path,`http://127.0.0.1:${issuer.address().port}/oauth/token`);
  const [first,second] = await Promise.all([sessionAuth(config,profileId,rotate), sessionAuth(config,profileId,rotate)]);
  for (const worker of [first,second]) assert.deepEqual(await worker.getTokens(), {
    type:'chatgptAuthTokens',accessToken:original,chatgptAccountId:account,chatgptPlanType:'plus',
  });
  const params = {reason:'unauthorized',previousAccountId:account};
  const rotations = await Promise.allSettled([first.refreshTokens(params),second.refreshTokens(params)]);
  for (const rotation of rotations) if (rotation.status === 'rejected') throw rotation.reason;
  const result = rotations.map(rotation => rotation.value);
  assert.equal(exchanges.length,1);
  assert.equal(exchanges[0].refresh_token,'refresh-original');
  assert.deepEqual(result[0],result[1]);
  assert.equal(result[0].accessToken,renewed);
  assert.equal(JSON.parse(await readFile(join(path,'auth.json'))).tokens.refresh_token,'refresh-next');
  await assert.rejects(first.refreshTokens({...params,previousAccountId:'different'}));
});
