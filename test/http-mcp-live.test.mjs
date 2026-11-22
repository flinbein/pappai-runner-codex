import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { AppServer } from '../src/client.mjs';
import { prepareWorker } from '../src/policy.mjs';
import { profileMethod } from '../src/profile.mjs';

async function endpoint(name,bearer) {
  const requests=[];
  const http=createServer(async (req,res)=>{
    requests.push({method:req.method,authorization:req.headers.authorization});
    if (req.method!=='POST') {res.writeHead(405).end(); return;}
    if (bearer && req.headers.authorization!=='Bearer '+bearer) {res.writeHead(403).end(); return;}
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const {id,method,params}=JSON.parse(Buffer.concat(chunks));
    let result;
    if (method==='initialize') result={protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name,version:'1'}};
    else if (method==='tools/list') result={tools:[{name,inputSchema:{type:'object'}}]};
    else if (method==='tools/call') result={content:[{type:'text',text:name}]};
    else if (id===undefined) {res.writeHead(202).end();return;}
    else result={};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id,result}));
  });
  http.listen(0,'127.0.0.1');
  await once(http,'listening');
  return {url:'http://127.0.0.1:'+http.address().port+'/mcp',requests,close:()=>{http.closeAllConnections();http.close();}};
}

test('real app-server enforces per-worker HTTP MCP selection and uses only the selected profile bearer', {
  skip:process.platform!=='linux'||!process.env.PAPPAI_TEST_CODEX_CLI,timeout:60000,
}, async t=>{
  const base='/run/pappai/private';
  await mkdir(base,{recursive:true,mode:0o700});
  const root=await mkdtemp(join(base,'mcp-live-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config={profilesDir:join(root,'profiles'),stateDir:join(root,'state'),
    codexExecutablePath:process.env.PAPPAI_TEST_CODEX_CLI,modelBaseUrl:'http://127.0.0.1:1/v1'};
  await mkdir(config.profilesDir,{mode:0o700});
  const profileId=randomUUID();
  await profileMethod(config,profileId,'setup',{authFile:'/tmp/test'},async()=>Buffer.from('{"OPENAI_API_KEY":"mock-only"}'));
  const bearer=randomUUID();
  const shared=await endpoint('shared',bearer), local=await endpoint('local');
  t.after(shared.close); t.after(local.close);
  await profileMethod(config,profileId,'mcp.set',{name:'shared',url:shared.url,bearerFile:'/tmp/test-token'},async()=>Buffer.from(bearer));
  for (const [network,profileMcpNetwork] of [[true,true],[true,false],[false,true],[false,false]]) {
    shared.requests.length=0; local.requests.length=0;
    const localName = profileMcpNetwork ? 'local' : 'shared';
    const options=await prepareWorker(config,{profileId,appId:randomUUID(),mode:'oneShot',sandbox:{network},profileMcpNetwork,
      settings:{config:{mcp_servers:{raw:{command:'/unavailable'}}},mcp:{profile:['shared'],servers:{[localName]:{url:local.url}}}}});
    const client=new AppServer(options,()=>{});
    try {
      await client.initialize();
      const {thread}=await client.rpc('thread/start',{...options.threadParams,ephemeral:true,model:'gpt-5.4'});
      const {data}=await client.rpc('mcpServerStatus/list',{threadId:thread.id});
      const expected = [];
      if (network) expected.push([localName,'local']);
      if (network && profileMcpNetwork) expected.push(['shared','shared']);
      assert.deepEqual(data.map(v=>v.name).sort(),expected.map(([server])=>server).sort());
      for(const [server,tool] of expected) {
        const result=await client.rpc('mcpServer/tool/call',{threadId:thread.id,server,tool,arguments:{}});
        assert.equal(result.content[0].text,tool);
      }
    } finally {await client.close();await options.cleanup();}
    assert.equal(shared.requests.length>0,network && profileMcpNetwork);
    assert.equal(local.requests.length>0,network);
    assert.ok(local.requests.every(request=>request.authorization===undefined));
  }
});
