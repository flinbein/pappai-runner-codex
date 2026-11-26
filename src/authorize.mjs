import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is mounted by itself in the USER terminal sandbox.
export async function authorize(codex, node, runner, pappai = '/usr/local/bin/pappai') {
  const root = process.env.PAPPAI_CLI_TMP;
  if (!root?.startsWith('/tmp/') || await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw Error('Missing private CLI temporary directory');
  }
  const home = await mkdtemp(join(root,'codex-'));
  let child, cancelled = false;
  const cancel = () => {
    cancelled = true;
    child?.kill('SIGTERM');
  };
  function run(command, args, env, stdio, failure) {
    if (cancelled) throw Error('Authorization cancelled');
    return new Promise((resolve,reject) => {
      child = spawn(command,args,{cwd:home,env,stdio});
      child.once('error',() => reject(Error(failure)));
      child.once('close',(code) => {
        child = undefined;
        if (cancelled) reject(Error('Authorization cancelled'));
        else if (code !== 0) reject(Error(failure));
        else resolve();
      });
    });
  }
  process.on('SIGINT',cancel);
  process.on('SIGTERM',cancel);
  try {
    const tmp = join(home,'tmp');
    await mkdir(tmp,{mode:0o700});
    const env = {HOME:home,CODEX_HOME:home,TMPDIR:tmp,PATH:'/usr/local/bin:/usr/bin:/bin',RUST_LOG:'off'};
    await run(codex,['--no-daemon','-c','cli_auth_credentials_store="file"','login','--device-auth'],
      env,'inherit','Codex device login failed');
    const authFile = join(home,'auth.json');
    if (!(await lstat(authFile)).isFile()) throw Error('Codex did not save credentials');
    await run(pappai,['call',node,runner+'.setup',JSON.stringify({authFile})],
      process.env,['ignore','ignore','inherit'],'Could not import Codex credentials');
    await run(pappai,['call',node,runner+'.status','{}'],
      process.env,'inherit','Could not read Codex connection status');
  } finally {
    try { await rm(home,{recursive:true,force:true}); }
    finally {
      process.off('SIGTERM',cancel);
      process.off('SIGINT',cancel);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  authorize(...process.argv.slice(2,5)).catch(error => {
    console.error(error.code ? 'Codex authorization file unavailable' : error.message);
    process.exitCode = 1;
  });
}
