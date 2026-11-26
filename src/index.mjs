import { RunnerHost } from './host.mjs'
import { prepareWorker } from './policy.mjs'
import { attachProfileMethods } from './profile.mjs'
import { join } from 'node:path'
import { CodexInstallation, runnerMethods } from './installation.mjs'
import settingsSchema from '../examples/settings-schema.json' with {type:'json'}

if (typeof process.send !== 'function') throw Error('Start the Codex runner through the pappai runner registry')
const config = JSON.parse(process.env.PAPPAI_RUNNER_CONFIG ?? '{}')
config.runnerName = process.env.PAPPAI_RUNNER_NAME || 'codex'
if (!/^[a-z][a-z0-9_-]{0,63}$/.test(config.runnerName)) throw Error('Invalid runner name')
config.stateDir ??= '/run/pappai/private/state'
if (config.runnerName !== 'codex') config.stateDir=join(config.stateDir,'instances',config.runnerName)
const installation = new CodexInstallation({
  toolsDir:process.env.PAPPAI_RUNNER_DIR ? join(process.env.PAPPAI_RUNNER_DIR,'tools') : undefined,
  configuredPath:config.codexExecutablePath,
})
function send(type,payload) {
  if (process.connected) process.send({type,payload},() => {})
}
const host = new RunnerHost(config,async (config,job) => {
  const codexExecutablePath=await installation.executable()
  return prepareWorker({...config,codexExecutablePath},job)
},send)
async function runnerCall({id,method,data}) {
  try {
    if (!Object.hasOwn(runnerMethods,method)) throw Error('Unknown runner method')
    if (!data || typeof data!=='object' || Array.isArray(data) ||
        Object.keys(data).some(key=>method!=='installCodex' || key!=='version')) throw Error('Invalid runner method arguments')
    const result=method==='getVersion' ? installation.status() : await installation.install(data.version)
    send('runnerReply',{id,result})
  } catch (error) { send('runnerReply',{id,error:error.message}) }
}
async function close() {
  await Promise.all([installation.close(),host.close()])
  if (process.connected) process.disconnect()
}
process.on('message', message => {
  if (message?.type === 'close') void close()
  else if (message?.type === 'runnerCall') void runnerCall(message)
  else if (message) host.receive(message)
})
process.on('disconnect',close)
process.on('SIGTERM',close)
process.on('SIGINT',close)
send('runnerReady',{kind:'codex',settingsSchema,methods:runnerMethods})
attachProfileMethods(config)
void installation.start().catch(()=>{}) // getVersion and waiting workers expose the issue
