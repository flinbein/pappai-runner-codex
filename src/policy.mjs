import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { AppServer } from './client.mjs';
import { resolveHttpMcp } from './http-mcp.mjs';
import { sessionAuth } from './session-auth.mjs';

const cliPath = '/opt/codex/bin/codex';
const home = '/state/codex';
const work = '/work';

async function canonicalFile(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
      await realpath(path) !== path || !(await lstat(path)).isFile()) {
    throw new Error(`Expected a canonical regular file for ${label}`);
  }
  return path;
}

function protectedBinary(path, mounts) {
  if (path.startsWith('/run/pappai/private/')) return true;
  const enclosing = mounts.filter(({target}) => target === '/' || path === target || path.startsWith(target + '/'));
  const depth = Math.max(...enclosing.map(({target}) => target.length));
  return enclosing.length > 0 && enclosing.filter(({target}) => target.length === depth).every(mount => mount.readonly);
}

async function privateDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) {
    throw new Error('Expected an absolute canonical runner state directory');
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || await realpath(path) !== path || (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.geteuid()) throw new Error('Runner state directory must be private and owned by the runner');
  return path;
}

function configToml(modelBaseUrl, codeMode) {
  const lines = [
    'approval_policy="never"', 'default_permissions="pappai"', 'web_search="disabled"',
    'cli_auth_credentials_store="file"', 'mcp_oauth_credentials_store="file"',
    'check_for_update_on_startup=false', 'project_doc_max_bytes=0',
  ];
  if (modelBaseUrl !== undefined) {
    const url = new URL(modelBaseUrl);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
      throw new Error('Invalid administrator model endpoint');
    }
    lines.push('model_provider="pappai"', '[model_providers.pappai]', 'name="pappai"',
      'wire_api="responses"', 'requires_openai_auth=true', 'supports_websockets=false',
      `base_url=${JSON.stringify(url.href)}`);
  }
  return [...lines,
    '[permissions.pappai.filesystem]', '"/work"="read"', '"/state"="deny"', '"/proc"="deny"',
    '[permissions.pappai.network]', 'enabled=false',
    '[features]', `code_mode=${codeMode}`, `code_mode_host=${codeMode}`,
    ...['apps','browser_use','browser_use_external',
      'computer_use','goals','hooks','image_generation','in_app_browser','memories','multi_agent_v2',
      'plugins','remote_plugin','shell_snapshot','shell_tool','skill_search','unified_exec','view_image',
      'workspace_dependencies'].map(key => `${key}=false`),
    'skip_host_skill_discovery=true', '[agents]', 'enabled=false', '[analytics]', 'enabled=false',
    '[feedback]', 'enabled=false', '',
  ].join('\n');
}

// Only the administrator supplies config. The APP cannot add mounts, a cwd, environment,
// config layers, or executable arguments. Personal state and installer files are never mounted.
export async function trustedDistribution(path) {
  const binary = await canonicalFile(path, 'Codex executable');
  const bwrap = await canonicalFile(join(dirname(dirname(binary)), 'codex-resources', 'bwrap'), 'bundled Codex bubblewrap');
  const codeModeHost = await canonicalFile(join(dirname(binary), 'codex-code-mode-host'), 'bundled Codex Code Mode host');
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
    const fields = line.split(' ');
    const target = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return {target, readonly:fields[5].split(',').includes('ro')};
  });
  if (![binary,bwrap,codeModeHost].every(path => protectedBinary(path,mounts))) {
    throw Error('Codex distribution must be on a read-only mount or below /run/pappai/private');
  }
  return {binary,bwrap,codeModeHost};
}

async function namespace(config, state, profileOwner, mcp) {
  const {binary,bwrap,codeModeHost:helper} = await trustedDistribution(config.codexExecutablePath);
  const codeModeHost = profileOwner ? null : helper;
  if (typeof config.stateDir !== 'string' || !config.stateDir.startsWith('/run/pappai/private/')) {
    throw new Error('Runner state must be below /run/pappai/private');
  }
  const root = await privateDir(config.stateDir);
  const toml = configToml(config.modelBaseUrl, codeModeHost !== null);
  const run = await mkdtemp(join(root, 'run-'));
  const cleanup = () => rm(run, { recursive: true, force: true });
  try {
    const configFile = join(run, 'config.toml');
    const requirements = join(run, 'requirements.toml');
    await writeFile(configFile, toml + (mcp?.configToml ?? ''), { mode: 0o600, flag: 'wx' });
    await writeFile(requirements, mcp?.requirementsToml ?? '[mcp_servers]\n', { mode: 0o600, flag: 'wx' });

    // This root has no shell, package manager, project checkout or system Codex settings.
    // The shared network is the app-server's service channel. Model tools run with a
    // separate, network-disabled permission profile and no selected environment.
    const args = ['--unshare-all', '--unshare-user', '--share-net', '--cap-drop', 'ALL',
      '--die-with-parent', '--new-session', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--dir', work, '--tmpfs', '/state', '--dir', home, '--dir', '/state/home', '--ro-bind', binary, cliPath,
      '--ro-bind', bwrap, '/opt/codex/bin/bwrap'];
    if (codeModeHost) args.push('--ro-bind', codeModeHost, '/opt/codex/bin/codex-code-mode-host');
    if (profileOwner) args.push('--bind', dirname(profileOwner.authPath), home);
    args.push('--ro-bind', configFile, home + '/config.toml', '--ro-bind', requirements, '/etc/codex/requirements.toml');
    for (const path of ['/etc/resolv.conf','/etc/hosts','/etc/ssl/certs/ca-certificates.crt']) {
      args.push('--ro-bind', path, path);
    }
    if (state) {
      await privateDir(state);
      for (const [dir, target] of [['sessions', home + '/sessions'], ['sqlite', '/state/sqlite']]) {
        args.push('--bind', await privateDir(join(state, dir)), target);
      }
    }
    args.push('--remount-ro', '/', '--chdir', work, '--clearenv', '--setenv', 'HOME', '/state/home',
      '--setenv', 'CODEX_HOME', home, '--setenv', 'CODEX_SQLITE_HOME', '/state/sqlite',
      '--setenv', 'PATH', '/opt/codex/bin', '--setenv', 'TMPDIR', '/tmp');
    if (profileOwner) args.push('--setenv', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', profileOwner.endpoint);
    args.push('--', cliPath, 'app-server', '--stdio', '--strict-config');
    return {
      executable: '/usr/bin/bwrap', args, cwd: run, env: {},
      threadParams: { cwd: work, permissions: 'pappai', approvalPolicy: 'never', environments: [] },
      stateFile: state ? join(state, 'thread.json') : null, cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Only this trusted control client can see the renewable credential. No turns,
// APP tools, or APP state are ever supplied to the profile owner.
export async function rotateProfile(config, authPath, endpoint = 'https://auth.openai.com/oauth/token') {
  const spec = await namespace(config, null, {authPath,endpoint});
  const rpc = new AppServer(spec, () => {});
  const deadline = setTimeout(() => rpc.close(), 20_000);
  try {
    await rpc.initialize({readAccount:false});
    await rpc.rpc('account/read', {refreshToken:true});
  } finally {
    clearTimeout(deadline);
    await rpc.close();
    await spec.cleanup();
  }
}

export async function prepareWorker(config, job) {
  if (process.platform !== 'linux') throw new Error('Codex workers require Linux bubblewrap');
  if (!job.profileId || typeof job.appId !== 'string' || !job.appId ||
      !['oneShot','persistent'].includes(job.mode)) throw new Error('Invalid Codex worker assignment');
  const auth = await sessionAuth(config, job.profileId, rotateProfile);
  const key = createHash('sha256').update(job.appId).digest('hex');
  const state = job.mode === 'persistent' ? join(config.stateDir, key) : null;
  return {...await namespace(config, state, null, await resolveHttpMcp(config,job)), sessionAuth:auth};
}
