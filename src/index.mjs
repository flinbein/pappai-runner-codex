import { RunnerHost } from './host.mjs'
import { prepareWorker } from './policy.mjs'
import { attachProfileMethods } from './profile.mjs'

if (typeof process.send !== 'function') throw Error('Start the Codex runner through the pappai runner registry')
const config = JSON.parse(process.env.PAPPAI_RUNNER_CONFIG ?? '{}')
attachProfileMethods()
const host = new RunnerHost(config,prepareWorker,(type,payload) => {
  if (process.connected) process.send({type,payload},() => {})
})
async function close() {
  await host.close()
  if (process.connected) process.disconnect()
}
process.on('message', message => {
  if (message?.type === 'close') void close()
  else if (message) host.receive(message)
})
process.on('disconnect',() => { void host.close() })
process.on('SIGTERM',close)
process.on('SIGINT',close)
