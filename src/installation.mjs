import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {trustedDistribution} from './policy.mjs';

const run = promisify(execFile);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const registry = 'https://registry.npmjs.org/';
const statusSchema = {type:'object', required:['version','status','source'], additionalProperties:false,
  properties:{version:{type:['string','null']}, status:{enum:['installing','ready','error']},
    source:{enum:['managed','configured']}, error:{type:'string'}}};
const input = properties => ({type:'object',properties,additionalProperties:false});
export const runnerMethods = {
  getVersion:{description:'Read the active Codex CLI version and installation status.',
    schema:{input:input({}),output:statusSchema}},
  installCodex:{description:'Install an exact stable Codex CLI version, or use the latest stable version.',
    schema:{input:input({version:{type:'string',pattern:stable.source,maxLength:64}}),output:statusSchema}},
};

function exact(version) {
  if (typeof version !== 'string' || version.length > 64 || !stable.test(version)) throw Error('Expected a stable Codex version (x.y.z)');
  return version;
}

async function latest(signal) {
  const response = await fetch(registry + '@openai%2fcodex/latest',{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
  if (!response.ok) throw Error('Could not resolve the latest stable Codex CLI (HTTP ' + response.status + ')');
  return exact((await response.json()).version);
}

async function download(stage,version,signal) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Managed Codex installation requires Linux x86_64');
  const prefix=join(stage,'npm');
  try {
    await run('npm',['install','--prefix',prefix,'--cache',join(stage,'cache'),'--registry',registry,
      '--no-save','--package-lock=false','--ignore-scripts','--no-audit','--no-fund',
      '@openai/codex@'+version+'-linux-x64'],{cwd:stage,signal,timeout:600000});
  } catch {
    throw Error('npm could not install the native Linux x64 Codex CLI '+version);
  }
  await rename(join(prefix,'node_modules','@openai','codex','vendor','x86_64-unknown-linux-musl'),join(stage,'distribution'));
}

async function inspect(path,signal) {
  await trustedDistribution(path);
  const {stdout} = await run(path,['--version'],{signal,timeout:10000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin'}});
  const match=/^codex-cli (\S+)$/.exec(stdout.trim());
  if (!match) throw Error('Unrecognized Codex CLI version');
  return match[1];
}

// Each registration has a single host. A worker pins its version-specific path for
// its lifetime, including token refreshes after an administrator changes the selection.
export class CodexInstallation {
  #active;
  #issue;
  #pending = Promise.resolve();
  #busy = 0;
  #stop = new AbortController();

  constructor({toolsDir,configuredPath,latest:resolveLatest=latest,download:fetchNative=download,inspect:probe=inspect}) {
    Object.assign(this,{toolsDir,configuredPath,resolveLatest,fetchNative,probe});
  }

  status() {
    return {source:this.#active?.source ?? (this.configuredPath ? 'configured' : 'managed'),
      version:this.#active?.version ?? null, status:this.#busy ? 'installing' : this.#active ? 'ready' : 'error',
      ...(this.#issue && {error:this.#issue})};
  }

  #operation(work) {
    this.#busy++;
    const result = this.#pending.then(async () => {
      try {
        this.#stop.signal.throwIfAborted();
        this.#issue=undefined;
        await work();
      } catch (error) {
        this.#issue = error.code ? 'Codex CLI storage or executable unavailable (' + error.code + ')' : error.message;
        throw Error(this.#issue);
      } finally { this.#busy--; }
      return this.status();
    });
    this.#pending=result.catch(()=>{});
    return result;
  }

  start() {
    return this.#operation(async () => {
      let selected;
      if (this.toolsDir) {
        try { selected=JSON.parse(await readFile(join(this.toolsDir,'selected.json'),'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (selected !== undefined) {
        await this.#select(exact(selected?.version),false);
      } else if (this.configuredPath) {
        const version=await this.probe(this.configuredPath,this.#stop.signal);
        this.#active={source:'configured',version,path:this.configuredPath};
      } else {
        await this.#install();
      }
    });
  }

  async executable() {
    if (!this.#active) await this.#pending;
    if (!this.#active) throw Error(this.#issue ?? 'Codex CLI unavailable');
    return this.#active.path;
  }

  install(version) {
    return this.#operation(()=>this.#install(version));
  }

  async #install(requested) {
    if (!this.toolsDir) throw Error('Installing Codex requires a managed runner directory');
    const version=exact(requested === undefined ? await this.resolveLatest(this.#stop.signal) : requested);
    await this.#select(version,true);
  }

  async #select(version,install) {
    const dest=join(this.toolsDir,version), path=join(dest,'bin','codex');
    const active={source:'managed',version,path};
    const verify = async file => {
      if (await this.probe(file,this.#stop.signal) !== version) throw Error('Codex executable version does not match the selected release');
    };
    let missing = false;
    try { await verify(path); }
    catch (error) {
      if (!install || error.code!=='ENOENT') throw error;
      missing = true;
    }
    if (!install) {
      this.#active=active;
      return;
    }
    await mkdir(this.toolsDir,{recursive:true,mode:0o700});
    const stage=await mkdtemp(join(this.toolsDir,'.install-'));
    try {
      if (missing) {
        await this.fetchNative(stage,version,this.#stop.signal);
        const dir=join(stage,'distribution');
        await verify(join(dir,'bin','codex'));
        await rename(dir,dest);
      }
      await writeFile(join(stage,'selected.json'),JSON.stringify({version})+'\n',{flag:'wx',mode:0o600});
      await rename(join(stage,'selected.json'),join(this.toolsDir,'selected.json'));
      this.#active=active;
    } finally { await rm(stage,{recursive:true,force:true}); }
  }

  async close() {
    this.#stop.abort();
    await this.#pending;
  }
}
