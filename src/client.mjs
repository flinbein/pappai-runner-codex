import { spawn } from 'node:child_process'

const maxFrame = 16 * 1024 * 1024
const rpcTimeout = 30_000

// Each app-server belongs to exactly one worker. Only an ended assistant
// message is a candidate result; deltas and commentary can be incomplete.
function finalText(item) {
  if (item?.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer') &&
      typeof item.text === 'string') return item.text
}

export class AppServer {
  #child
  #requests = new Map()
  #serial = 0
  #turn
  #failure
  #closing
  #ended = Promise.withResolvers()
  #auth
  #tool
  #serverRequests = new Set()
  #fail

  constructor({executable,args,cwd,env,sessionAuth},onLoss,onTool) {
    this.#auth = sessionAuth
    this.#tool = onTool
    const child = this.#child = spawn(executable,args,{cwd,env,stdio:'pipe',windowsHide:true})
    const fail = error => {
      if (this.#failure) return
      this.#failure = error
      for (const pending of this.#requests.values()) pending.reject(error)
      this.#requests.clear()
      this.#turn?.done.reject(error)
      this.#turn?.ready.resolve(null)
      if (!this.#closing) onLoss(error)
    }
    this.#fail = fail
    // stderr may contain provider data. Drain it without exposing credentials,
    // prompts or installation paths through a user-visible executor error.
    child.stderr.resume()
    child.stdin.on('error',() => fail(Error('Codex input closed')))
    child.once('error',() => fail(Error('Could not launch Codex app-server')))
    child.once('exit',(code,signal) => {
      fail(Error('Codex app-server exited (' + (signal ?? code) + ')'))
      // An inherited pipe must not retain a worker slot after its process exits.
      const drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() },250)
      child.once('close',() => clearTimeout(drain))
    })
    child.once('close',() => this.#ended.resolve(true))
    let chunks = [], length = 0
    child.stdout.on('data', chunk => {
      if (this.#failure) return
      let start = 0
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10,start)) {
        if (length + i - start > maxFrame) return fail(Error('Codex protocol frame too large'))
        chunks.push(chunk.subarray(start,i))
        try { this.#message(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { return fail(Error('Invalid Codex protocol frame')) }
        chunks = []
        length = 0
        start = i + 1
      }
      if (start < chunk.length) {
        length += chunk.length - start
        if (length > maxFrame) return fail(Error('Codex protocol frame too large'))
        chunks.push(chunk.subarray(start))
      }
    })
    child.stdout.once('end',() => fail(Error('Codex output closed')))
  }

  #send(value) {
    if (this.#failure) throw this.#failure
    if (this.#closing) throw Error('Codex app-server is closing')
    this.#child.stdin.write(JSON.stringify(value) + '\n')
  }

  #message(message) {
    if (message.id !== undefined) {
      if (message.method) {
        if (this.#serverRequests.size >= 32 || this.#serverRequests.has(message.id)) throw Error('Too many open server requests')
        this.#serverRequests.add(message.id)
        void this.#serverRequest(message)
        return
      }
      const request = this.#requests.get(message.id)
      if (!request) return
      this.#requests.delete(message.id)
      if (message.error) request.reject(Error('Codex rejected ' + request.method))
      else request.resolve(message.result)
      return
    }
    const active = this.#turn
    const {method,params} = message
    if (!active || params?.threadId !== active.threadId ||
        (method !== 'item/completed' && method !== 'turn/completed')) return
    const id = method === 'turn/completed' ? params.turn.id : params.turnId
    if (typeof id !== 'string' || (active.id && active.id !== id)) return
    if (!active.records.has(id) && active.records.size >= 8) throw Error('Too many simultaneous turns')
    const record = active.records.get(id) ?? {}
    active.records.set(id,record)
    if (method === 'item/completed') record.text = finalText(params.item) ?? record.text
    else {
      record.status = params.turn.status
      for (const item of params.turn.items ?? []) record.text = finalText(item) ?? record.text
      if (active.id === id) active.done.resolve(record)
    }
  }

  async #serverRequest({id,method,params}) {
    let response
    try {
      if (method === 'account/chatgptAuthTokens/refresh' && this.#auth) {
        response = {result:await this.#auth.refreshTokens(params)}
      } else if (method === 'item/tool/call' && this.#tool) {
        const active = this.#turn
        if (!active || params.threadId !== active.threadId || typeof params.callId !== 'string' || !params.callId ||
            typeof params.turnId !== 'string' || params.turnId !== await active.ready.promise || active !== this.#turn ||
            active.records.get(params.turnId)?.status || active.callIds.has(params.callId) || active.callIds.size >= 1024)
          throw Error('Tool request has no active assignment')
        active.callIds.add(params.callId)
        response = {result:await this.#tool(params)}
      } else response = {error:{code:-32601,message:'Unsupported server request'}}
    } catch {
      response = {error:{code:-32000,message:'Runner rejected the server request'}}
    } finally {
      this.#serverRequests.delete(id)
    }
    if (!this.#failure && !this.#closing) this.#send({id,...response})
  }

  async rpc(method,params) {
    const id = ++this.#serial
    const pending = Promise.withResolvers()
    this.#requests.set(id,{...pending,method})
    const timer = setTimeout(() => pending.reject(Error('Codex did not acknowledge ' + method)),rpcTimeout)
    try {
      this.#send({id,method,params})
      return await pending.promise
    } finally {
      clearTimeout(timer)
      this.#requests.delete(id)
    }
  }

  async initialize({readAccount=true}={}) {
    const {userAgent} = await this.rpc('initialize',{
      clientInfo:{name:'pappai_runner_codex',version:'1'},capabilities:{experimentalApi:true},
    })
    if (typeof userAgent !== 'string' || !/\/0\.170\.0(?:\s|$)/.test(userAgent)) throw Error('Codex CLI 0.170.0 is required')
    this.#send({method:'initialized'})
    if (!readAccount) return
    if (this.#auth) {
      const login = await this.#auth.getTokens()
      await this.rpc('account/login/start',login)
    }
    const {account} = await this.rpc('account/read',{})
    if (!account) throw Error('Codex profile has no authenticated account')
  }

  async turn(params,onStarted) {
    const active = this.#turn = {threadId:params.threadId,records:new Map(),done:Promise.withResolvers(),
      ready:Promise.withResolvers(),callIds:new Set()}
    // Loss can occur before the turn/start acknowledgement.
    active.done.promise.catch(() => {})
    try {
      const {turn} = await this.rpc('turn/start',params)
      if (typeof turn?.id !== 'string' || !turn.id) throw Error('Codex returned no turn ID')
      active.id = turn.id
      await onStarted()
      active.ready.resolve(turn.id)
      const early = active.records.get(turn.id)
      return early?.status ? early : await active.done.promise
    } finally {
      active.ready.resolve(null)
      this.#turn = undefined
    }
  }

  async interrupt() {
    const active = this.#turn
    if (!active || !await active.ready.promise || active !== this.#turn || active.records.get(active.id)?.status)
      throw Error('No active Codex turn')
    active.interrupting ??= this.rpc('turn/interrupt',{threadId:active.threadId,turnId:active.id})
    await active.interrupting
    return {interrupted:true}
  }

  close() {
    if (this.#closing) return this.#closing
    const kill = setTimeout(() => this.#child.kill('SIGKILL'),1000)
    const deadline = setTimeout(() => {
      this.#fail(Error('Codex executor stop could not be confirmed'))
      for (const pipe of this.#child.stdio) pipe?.destroy()
      this.#child.unref()
      this.#ended.resolve(false)
    },3000)
    this.#closing = this.#ended.promise.finally(() => { clearTimeout(kill); clearTimeout(deadline) })
    this.#child.stdin.end()
    return this.#closing
  }
}
