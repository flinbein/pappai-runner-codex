import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { profileDirectory } from './profile.mjs';

const denied = {configToml:'', requirementsToml:'[mcp_servers]\n'};
const keyPattern = /^[a-z][a-z0-9_-]{0,47}$/;
function validName(name) {
  if (typeof name!=='string' || !keyPattern.test(name) || Object.hasOwn(Object.prototype,name)) throw Error('Invalid MCP name');
  return name;
}
function keys(value, allowed) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))
    throw Error('Unsupported MCP settings');
}
function endpoint(value) {
  if (typeof value!=='string' || value.length>2048) throw Error('Invalid MCP URL');
  const url=new URL(value);
  if (url.username || url.password || url.hash || url.search ||
      !(url.protocol==='https:' || (url.protocol==='http:' && ['127.0.0.1','[::1]'].includes(url.hostname))))
    throw Error('Expected HTTPS or local loopback HTTP MCP URL without credentials, query or fragment');
  return url.href;
}

async function serverDir(config,id,create) {
  const directory=join(await profileDirectory(config,id,create),'mcp');
  if (create) await mkdir(directory,{recursive:true,mode:0o700});
  if (!(await lstat(directory)).isDirectory() || await realpath(directory)!==directory) throw Error('Invalid MCP storage');
  return directory;
}
async function stored(directory,name) {
  const path=join(directory,validName(name)+'.json');
  if (!(await lstat(path)).isFile()) throw Error('Invalid MCP storage');
  return JSON.parse(await readFile(path,'utf8'));
}

export async function mcpMethod(config,id,method,data={},reader) {
  if (method==='mcp.get') {
    keys(data,[]);
    let directory;
    try { directory=await serverDir(config,id,false); } catch (e) { if (e.code==='ENOENT') return {}; throw e; }
    const entries=[];
    for (const file of (await readdir(directory)).sort()) {
      if (!file.endsWith('.json')) continue;
      const name=file.slice(0,-5);
      const item=await stored(directory,name);
      entries.push([name,{url:item.url,authenticated:Boolean(item.bearer)}]);
    }
    return Object.fromEntries(entries);
  }
  if (method==='mcp.delete') {
    keys(data,['name']); validName(data.name);
    try { await rm(join(await serverDir(config,id,false),data.name+'.json'),{force:true}); }
    catch(e) {if(e.code!=='ENOENT') throw e;}
    return {};
  }
  if (method!=='mcp.set') throw Error('Unknown MCP operation');
  keys(data,['name','url','bearerFile']);
  const name=validName(data.name);
  const entry={url:endpoint(data.url)};
  if (Object.hasOwn(data,'bearerFile')) {
    if (typeof data.bearerFile!=='string' || !data.bearerFile.startsWith('/')) throw Error('Expected absolute bearerFile');
    const bytes=await reader(data.bearerFile);
    const value=bytes.toString('utf8').trim();
    if (value.length>8192 || !/^[A-Za-z0-9._~+/=-]+$/.test(value)) throw Error('Invalid bearer token');
    entry.bearer=value;
  }
  const dir=await serverDir(config,id,true);
  const path=join(dir,name+'.json');
  try { await lstat(path); }
  catch(error) {
    if(error.code!=='ENOENT') throw error;
    if ((await readdir(dir)).filter(file=>file.endsWith('.json')).length>=64) throw Error('Too many MCP servers');
  }
  const temp=join(dir,randomUUID()+'.tmp');
  try {
    await writeFile(temp,JSON.stringify(entry),{mode:0o600,flag:'wx'});
    await rename(temp,path);
  } finally { await rm(temp,{force:true}); }
  return {};
}

export async function resolveHttpMcp(config,job) {
  const mcp=job.settings?.mcp;
  if (!mcp || (job.sandbox!==null && job.sandbox?.network!==true)) return denied;
  keys(mcp,['profile','servers']);
  // Older controllers omit this grant. Ignore denied selections before reading profile storage.
  const selected=job.profileMcpNetwork===true ? (mcp.profile ?? []) : [];
  if (!Array.isArray(selected) || selected.length>64) throw Error('Invalid MCP profile selection');
  const local=mcp.servers ?? {};
  if (!local || typeof local!=='object' || Array.isArray(local) || Object.keys(local).length+selected.length>64) throw Error('Invalid MCP servers');
  const entries=new Map();
  for (const [name,entry] of Object.entries(local)) {
    keys(entry,['url']); entries.set(validName(name),{url:endpoint(entry.url)});
  }
  for (const name of selected) {
    validName(name);
    if (entries.has(name)) throw Error('Duplicate MCP server name');
    try { entries.set(name,await stored(await serverDir(config,job.profileId,false),name)); }
    catch (err) { if (err.code==='ENOENT') throw Error('Unknown profile MCP server'); throw err; }
  }
  if (!entries.size) return denied;
  const configLines=[], requirements=[];
  for (const [name,{url,bearer}] of entries) {
    configLines.push('[mcp_servers.'+name+']','url='+JSON.stringify(endpoint(url)),'default_tools_approval_mode="approve"');
    if (bearer) configLines.push('http_headers={Authorization='+JSON.stringify('Bearer '+bearer)+'}');
    requirements.push('[mcp_servers.'+name+'.identity]','url='+JSON.stringify(endpoint(url)));
  }
  return {configToml:configLines.join('\n')+'\n', requirementsToml:requirements.join('\n')+'\n'};
}
