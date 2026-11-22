import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/app-server.mjs',import.meta.url))
const profileId = '48b1e80b-4187-43f1-8c86-ab6fe46bed82'
const makeJob = (id,fields={}) => ({id,appId:'app',profileId,from:'caller',method:'agent.execute',
  data:'hello',settings:{},mode:'oneShot',...fields})

async function harness(t,prepareSpec) {
  const { RunnerHost } = await import('../src/host.mjs')
  const dir = await mkdtemp(join(tmpdir(),'codex-runner-'))
  const stateFile = join(dir,'thread.json'), log = join(dir,'log.jsonl')
  const prepare = prepareSpec ? () => prepareSpec(dir,stateFile) : async () => ({
    executable:process.execPath, args:[fixture,log], cwd:dir, env:{}, threadParams:{cwd:dir},
    stateFile, async cleanup() {},
  })
  const hosts = []
  const start = () => {
    const messages = [], events = new EventEmitter()
    const host = new RunnerHost({},prepare,(type,payload) => {messages.push({type,payload}); events.emit('update')})
    hosts.push(host)
    const wait = async (type,id) => {
      const signal = AbortSignal.timeout(prepareSpec ? 30_000 : 5000)
      for (;;) {
        const found = messages.find(message => message.type === type && message.payload.id === id)
        if (found) return found.payload
        const exit = messages.find(message => message.type === 'exit' && message.payload.id === id)
        if (exit) throw Error('Worker exited while waiting for ' + type + ': ' + JSON.stringify(exit.payload))
        await once(events,'update',{signal})
      }
    }
    return {host,wait,messages}
  }
  t.after(async () => {
    await Promise.all(hosts.map(host => host.close()))
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  })
  return {start, stateFile, log:async () => (await readFile(log,'utf8')).trim().split('\n').map(line => JSON.parse(line))}
}

test('oneShot sends a single ephemeral typed turn and returns the validated value',async t => {
  const h = await harness(t), {host,wait} = h.start()
  host.receive({type:'dispatch', job:makeJob('x',{outputSchema:{type:'integer'}})})
  assert.equal((await wait('reply','x')).result,7)
  await wait('exit','x')
  const log = await h.log()
  assert.equal(log.find(entry => entry.method === 'thread/start').params.ephemeral,true)
  const turn = log.find(entry => entry.method === 'turn/start').params
  assert.deepEqual(turn.outputSchema.properties.result,{type:'integer'})
  assert.deepEqual(JSON.parse(turn.input[0].text),{from:'caller',method:'agent.execute',data:'hello'})
  await assert.rejects(readFile(h.stateFile),{code:'ENOENT'})
})

test('persistent delivery honours holdFirst and resumes the APP thread across hosts',async t => {
  const h=await harness(t), first=h.start()
  first.host.receive({type:'dispatch',job:makeJob('a',{mode:'persistent',holdFirst:true})})
  await first.wait('started','a')
  assert.equal((await h.log()).some(e => e.method === 'turn/start'),false)
  first.host.receive({type:'deliver',id:'a',item:{id:'a',from:'source',event:'changed',subscription:'mine',data:1}})
  await first.wait('written','a')
  assert.equal(first.messages.some(e => e.type === 'reply'),false)
  first.host.receive({type:'deliver',id:'a',item:{id:'b',method:'chat',from:'user',data:2}})
  assert.equal((await first.wait('reply','b')).result,'reply-2')
  await first.host.close()
  const next=h.start()
  next.host.receive({type:'dispatch',job:makeJob('c',{mode:'persistent'})})
  assert.equal((await next.wait('reply','c')).result,'reply-hello')
  const log=await h.log()
  assert.equal(log.filter(e => e.method === 'thread/start').length,1)
  assert.equal(log.find(e => e.method === 'thread/resume').params.threadId,log.find(e => e.accepted).accepted)
  assert.deepEqual(JSON.parse(log.find(e => e.method === 'turn/start').params.input[0].text),
    {from:'source',event:'changed',subscription:'mine',data:1})
})

test('model failures, missing final content and malformed or mismatched JSON never succeed',async t => {
  const h=await harness(t), {host,wait}=h.start()
  for (const data of ['failed','empty','invalid','malformed']) {
    host.receive({type:'dispatch',job:makeJob(data,{data,outputSchema:{type:'integer'}})})
    assert.ok((await wait('reply',data)).error)
    await wait('exit',data)
  }
})

test('unexpected subprocess loss and a lifetime exceeded release the assigned worker',async t => {
  const h=await harness(t), {host,wait}=h.start()
  host.receive({type:'dispatch',job:makeJob('exit',{data:'exit'})})
  assert.ok((await wait('exit','exit')).issue)
  host.receive({type:'dispatch',job:makeJob('timeout',{data:'hold',maxLifetimeMs:250})})
  assert.match((await wait('exit','timeout')).issue,/lifetime/i)
})

test('an open persistent turn can be cancelled without replying or losing subsequent work',async t => {
  const h=await harness(t), {host,wait,messages}=h.start()
  host.receive({type:'dispatch',job:makeJob('cancel',{mode:'persistent',data:'hold'})})
  await wait('started','cancel')
  host.receive({type:'notify',id:'cancel',notification:{cancelled:'cancel'}})
  await wait('written','cancel')
  assert.equal(messages.some(e => e.type === 'reply'),false)
  host.receive({type:'deliver',id:'cancel',item:{id:'next',from:'caller',method:'chat',data:'continued'}})
  assert.equal((await wait('reply','next')).result,'reply-continued')
})

test('pappai tool calls use the assigned worker identity and expose the controller response',async t => {
  const h=await harness(t), {host,wait,messages}=h.start()
  host.receive({type:'dispatch',job:makeJob('tools',{data:'tool'})})
  await wait('started','tools')
  const signal=AbortSignal.timeout(3000)
  while (!messages.some(e => e.type === 'request')) {
    signal.throwIfAborted()
    await new Promise(resolve => setTimeout(resolve,10))
  }
  const {payload}=messages.find(e => e.type === 'request')
  assert.deepEqual({appId:payload.appId,workerId:payload.workerId,method:payload.method,params:payload.params},
    {appId:'app',workerId:'tools',method:'call',params:{node:'target',method:'read',data:1}})
  host.receive({type:'response',id:'tools',requestId:payload.id,response:{result:'permitted'}})
  assert.equal((await wait('reply','tools')).result,'"permitted"')
})

test('external ChatGPT tokens are installed and refreshed through the assigned profile',async t => {
  let refreshed
  const h=await harness(t,async (dir,stateFile) => ({
    executable:process.execPath,args:[fixture,join(dir,'log.jsonl')],env:{},cwd:dir,stateFile,threadParams:{},
    sessionAuth:{
      async getTokens() { return {type:'chatgptAuthTokens',accessToken:'initial',chatgptAccountId:'work'} },
      async refreshTokens(params) { refreshed=params; return {accessToken:'refreshed',chatgptAccountId:'work'} },
    },async cleanup() {},
  }))
  const {host,wait}=h.start()
  host.receive({type:'dispatch',job:makeJob('login')})
  assert.equal((await wait('reply','login')).result,'reply-hello')
  assert.deepEqual(refreshed,{reason:'unauthorized',previousAccountId:'work'})
})

test('persistent getHistory reads a native page, exposing only user and final assistant text',async t => {
  const h=await harness(t), {host,wait}=h.start()
  host.receive({type:'dispatch',job:makeJob('first',{mode:'persistent'})})
  await wait('written','first')
  host.receive({type:'deliver',id:'first',item:{id:'history',from:'caller',method:'agent.getHistory',data:{limit:4}}})
  assert.deepEqual((await wait('reply','history')).result,{messages:[
    {role:'user',text:'hello'},{role:'assistant',text:'world'},
  ],nextCursor:'next-page'})
  assert.equal((await h.log()).filter(entry => entry.method === 'turn/start').length,1)
})

test('direct interrupt acknowledges the actual running turn without scheduling another model turn',async t => {
  const h=await harness(t), {host,wait}=h.start()
  host.receive({type:'dispatch',job:makeJob('busy',{mode:'persistent',data:'hold'})})
  await wait('started','busy')
  host.receive({type:'notify',id:'busy',notification:{interrupt:'control'}})
  assert.deepEqual((await wait('reply','control')).result,{interrupted:true})
  assert.match((await wait('reply','busy')).error.message,/interrupted/)
  await wait('written','busy')
  host.receive({type:'notify',id:'busy',notification:{interrupt:'idle'}})
  assert.match((await wait('reply','idle')).error.message,/No active Codex turn/)
  assert.equal((await h.log()).filter(entry => entry.method === 'turn/start').length,1)
})

test('real Codex sends structured output format and restores a previous turn to the provider',
  {skip:!process.env.PAPPAI_TEST_CODEX_CLI},async t => {
    const requests=[]
    const http=createServer(async (req,res) => {
      if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer offline-profile') return res.writeHead(401).end()
      const bytes=[]
      for await (const chunk of req) bytes.push(chunk)
      const body=JSON.parse(Buffer.concat(bytes))
      requests.push(body)
      const id='resp_' + requests.length
      const text=body.text?.format?.type === 'json_schema' ? '{"result":7}' : 'Fixture says hello.'
      const item={type:'message',id:'msg_' + requests.length,role:'assistant',status:'completed',
        content:[{type:'output_text',text,annotations:[]}]}
      const events=[{type:'response.created',response:{id}},{type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response:{id,usage:{input_tokens:2,output_tokens:2,total_tokens:4}}}]
      res.writeHead(200,{'content-type':'text/event-stream'})
      res.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''))
    })
    http.listen(0,'127.0.0.1')
    await once(http,'listening')
    t.after(() => { http.closeAllConnections(); http.close() })
    const h=await harness(t,async (dir,stateFile) => {
      const home=join(dir,'codex'), work=join(dir,'work')
      await mkdir(home,{recursive:true})
      await mkdir(work,{recursive:true})
      await writeFile(join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'offline-profile'}))
      await writeFile(join(home,'config.toml'),[
        'model="gpt-5.4"', 'model_provider="fixture"', 'cli_auth_credentials_store="file"',
        '[model_providers.fixture]', 'name="fixture"', 'wire_api="responses"', 'requires_openai_auth=true',
        'supports_websockets=false', 'base_url="http://127.0.0.1:' + http.address().port + '/v1"','',
      ].join('\n'))
      const env={HOME:dir,USERPROFILE:dir,APPDATA:dir,LOCALAPPDATA:dir,CODEX_HOME:home,TEMP:dir,TMP:dir}
      if (process.platform === 'win32') env.SystemRoot=process.env.SystemRoot
      return {executable:process.env.PAPPAI_TEST_CODEX_CLI,args:['app-server','--listen','stdio://'],cwd:work,env,
        threadParams:{cwd:work,sandbox:'read-only',approvalPolicy:'never'},stateFile,async cleanup() {}}
    })
    const first=h.start()
    first.host.receive({type:'dispatch',job:makeJob('first',{mode:'persistent',data:'PRIVATE-HISTORY-MARKER',outputSchema:{type:'integer'}})})
    assert.equal((await first.wait('reply','first')).result,7)
    await first.host.close()
    const next=h.start()
    next.host.receive({type:'dispatch',job:makeJob('next',{mode:'persistent',data:'continue'})})
    assert.equal((await next.wait('reply','next')).result,'Fixture says hello.')
    assert.equal(requests.length,2)
    assert.match(JSON.stringify(requests[1].input),/PRIVATE-HISTORY-MARKER/)
    assert.match(JSON.stringify(requests[1].input),/continue/)
  })
