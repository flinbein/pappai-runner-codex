import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveHttpMcp, mcpMethod } from '../src/http-mcp.mjs';

test('layers select only explicit servers. Network revocation removes HTTP and its credentials', async t=>{
  const root=process.platform==='linux'?'/run/pappai/private':tmpdir();
  await mkdir(root,{recursive:true,mode:0o700});
  const profilesDir=await mkdtemp(join(root,'mcp-fixture-'));
  t.after(()=>rm(profilesDir,{recursive:true,force:true}));
  const config={profilesDir};
  const profileId=randomUUID();
  const job={profileId,sandbox:{network:true},settings:{mcp:{profile:['tasks'],servers:{calendar:{url:'https://calendar.example.test/mcp'}}}}};
  let result=await mcpMethod(config,profileId,'mcp.set',{name:'tasks',url:'https://tasks.example.test/api',bearerFile:'/tmp/fixture'},async()=>Buffer.from('fixture-bearer'));
  assert.deepEqual(result,{});
  const listed=await mcpMethod(config,profileId,'mcp.get',{});
  assert.deepEqual(listed,{tasks:{url:'https://tasks.example.test/api',authenticated:true}});
  const resolved=await resolveHttpMcp(config,job);
  assert.match(resolved.configToml,/fixture-bearer/);
  assert.match(resolved.requirementsToml,/calendar.example.test/);
  assert.ok(!resolved.requirementsToml.includes('fixture-bearer'));
  assert.deepEqual(await resolveHttpMcp(config,{...job,sandbox:{network:false}}),{configToml:'',requirementsToml:'[mcp_servers]\n'});
  await assert.rejects(resolveHttpMcp(config,{...job,settings:{mcp:{profile:['tasks'],servers:{tasks:{url:'https://other.example.test'}}}}}),/duplicate/i);
  await mcpMethod(config,profileId,'mcp.set',{name:'tasks',url:'https://new.example.test/mcp'});
  assert.ok(!(await resolveHttpMcp(config,job)).configToml.includes('fixture-bearer'));
  await mcpMethod(config,profileId,'mcp.delete',{name:'tasks'});
  await assert.rejects(resolveHttpMcp(config,job),/unknown/i);
});

test('APP cannot pass stdio, http helper commands, credentials in urls, or unscoped local token sources', async ()=>{
  for (const settings of [{command:'tool'},{url:'https://user:pass@host/mcp'},{url:'http://example.test'},
    {url:'https://example.test',bearerFile:'/tmp/test'},{url:'https://example.test',http_headers_helper:'tool'}]) {
    await assert.rejects(resolveHttpMcp({}, {profileId:randomUUID(),sandbox:null,settings:{mcp:{servers:{fixture:settings}}}}));
  }
});
