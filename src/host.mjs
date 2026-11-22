import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { AppServer } from './client.mjs'
import { dynamicTools, toolMethods } from './tools.mjs'

const ajv = new Ajv2020({strict:true,addUsedSchema:false,ownProperties:true})
addFormats(ajv)

async function savedThread(file) {
  let value
  try { value = await readFile(file,'utf8') }
  catch (error) { if (error.code === 'ENOENT') return; throw Error('Cannot read APP thread state') }
  try {
    const {threadId} = JSON.parse(value)
    if (typeof threadId === 'string' && threadId) return threadId
  } catch { /* refuse to replace corrupt history */ }
  throw Error('Invalid APP thread state')
}

async function saveThread(file,threadId) {
  const tmp = file + '.' + randomUUID()
  try {
    await writeFile(tmp,JSON.stringify({threadId}),{flag:'wx',mode:0o600})
    await rename(tmp,file)
  } catch {
    throw Error('Cannot persist APP thread state')
  } finally {
    await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw Error('Cannot clean up APP thread state') })
  }
}

function turnRequest(threadId,item,effort) {
  const record = {from:item.from,...(item.method ? {method:item.method} : {event:item.event,subscription:item.subscription}),data:item.data}
  const input = [{type:'text',text:JSON.stringify(record)}]
  const params = {threadId,input,environments:[],...(effort && {effort})}
  let validate
  if (item.method && item.outputSchema !== undefined) {
    const schema = item.outputSchema
    validate = ajv.compile(schema)
    if (typeof schema === 'object') ajv.removeSchema(schema)
    // A root-relative reference must keep its original schema resource. Give
    // these schemas to the model as instructions and validate locally.
    if (/"\$(?:ref|dynamicRef|id|schema)"\s*:/.test(JSON.stringify(schema))) {
      input.push({type:'text',text:'Return only a JSON object with a result property matching this JSON Schema: ' + JSON.stringify(schema)})
    } else {
      params.outputSchema = {type:'object',properties:{result:schema},required:['result'],additionalProperties:false}
    }
  }
  return {params,validate}
}

function resultOf(text,validate) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Codex completed without a final assistant message')
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Codex result exceeds 1 MiB')
  if (!validate) return text
  let value
  try { value = JSON.parse(text) } catch { throw Error('Codex returned malformed JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value,'result') ||
      Object.keys(value).length !== 1 || !validate(value.result)) throw Error('Codex result does not match the output schema')
  return value.result
}

async function history(client,threadId,data,hasTurns) {
  const {limit=20,cursor}=data ?? {}
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (cursor != null &&
      (typeof cursor !== 'string' || cursor.length > 4096))) throw Error('Invalid history page')
  if (!hasTurns) return {messages:[],nextCursor:null}
  const page = await client.rpc('thread/items/list',{threadId,limit,cursor,sortDirection:'asc'})
  const messages = []
  for (const {item} of page.data) {
    const user = item.type === 'userMessage'
    // The runner writes the pappai record as the first text block. Subsequent
    // blocks can contain runner instructions for models with structured output.
    let text = user && item.content[0]?.type === 'text' ? item.content[0].text : undefined
    if (item.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')) text = item.text
    if (typeof text !== 'string') continue
    const bytes = Buffer.from(text), truncated = bytes.length > 8192
    messages.push({role:user ? 'user' : 'assistant',text:truncated ? bytes.subarray(0,8192).toString('utf8') : text,
      ...(truncated && {truncated:true})})
  }
  return {messages,nextCursor:page.nextCursor ?? null}
}

class Worker {
  #incoming = Promise.withResolvers()
  #queued = false
  #active
  #cancelled
  #cancelTimer
  #client
  #stopping = false
  #issue
  #started = false
  #outgoing = new Map()

  constructor(job,emit) {
    this.job = job
    this.emit = (type,fields={}) => emit(type,{appId:job.appId,id:job.id,...fields})
    this.persistent = job.mode === 'persistent'
  }

  deliver(item) {
    if (this.#stopping) return
    if (this.#queued || this.#active) return this.stop('Concurrent delivery to Codex worker')
    this.#queued = true
    this.#incoming.resolve(item)
  }

  cancel(id) {
    if (this.#stopping) return
    if (id !== this.#active?.id && (this.#started || id !== this.job.id) && !this.#queued) return
    this.#cancelled = id
    // The controller aborts outstanding executor requests on worker exit.
    if (this.#active?.id === id && this.#outgoing.size) return this.stop()
    if (this.#active?.id === id && this.#active.method !== 'agent.getHistory') this.#interrupt()
  }

  async #tool({tool,namespace,arguments:params}) {
    const method = toolMethods.get(tool)
    if (!method || namespace != null || this.#stopping || !this.#active || this.#cancelled === this.#active.id ||
        this.#outgoing.size >= 32 || !params || typeof params !== 'object' || Array.isArray(params) ||
        Buffer.byteLength(JSON.stringify(params)) > 64 * 1024) throw Error('Invalid workspace tool request')
    const id = randomUUID()
    const pending = Promise.withResolvers()
    this.#outgoing.set(id,pending)
    try {
      this.emit('request',{id,workerId:this.job.id,method,params})
      const response = await pending.promise
      const error = Object.hasOwn(response,'error')
      const text = error ? String(response.error?.message ?? 'Workspace request failed') : JSON.stringify(response.result ?? null)
      if (Buffer.byteLength(text) > 1024 * 1024) return {success:false,contentItems:[{type:'inputText',text:'Workspace result exceeds 1 MiB'}]}
      return {success:!error,contentItems:[{type:'inputText',text}]}
    } finally {
      this.#outgoing.delete(id)
    }
  }

  respond(id,response) {
    this.#outgoing.get(id)?.resolve(response)
  }

  async interrupt(id) {
    const fields = {id,workerId:this.job.id}
    try {
      if (!this.persistent || this.#stopping || !this.#client) throw Error('No active Codex turn')
      const result = await this.#client.interrupt()
      if (!this.#stopping) this.emit('reply',{...fields,result})
    } catch (error) {
      if (!this.#stopping) this.emit('reply',{...fields,error:{message:error.message}})
    }
  }

  #interrupt() {
    if (!this.#cancelTimer) this.#cancelTimer = setTimeout(() => this.stop('Codex turn cancellation timed out'),5000)
    this.#client?.interrupt().catch(error => {
      if (error.message !== 'No active Codex turn') this.stop('Could not interrupt Codex turn')
    })
  }

  stop(issue) {
    if (issue) this.#issue ??= issue
    if (this.#stopping) return
    this.#stopping = true
    this.#incoming.resolve(null)
    for (const pending of this.#outgoing.values()) pending.reject(Error('Worker stopped'))
    this.#client?.close()
  }

  async run(config,prepare) {
    let spec, permanent = false
    const lifetime = this.job.maxLifetimeMs && setTimeout(() => this.stop('Codex executor lifetime exceeded'),this.job.maxLifetimeMs)
    try {
      if (!this.job.profileId) throw Error('Codex requires an assigned profile')
      spec = await prepare(config,this.job)
      if (this.#stopping) return
      const client = this.#client = new AppServer(spec,error => this.stop(error.message),params => this.#tool(params))
      await client.initialize()
      if (this.#stopping) return
      const settings = this.job.settings
      const params = {
        ...(settings.model && {model:settings.model}),
        ...(settings.developerInstructions && {developerInstructions:settings.developerInstructions}),
        ...spec.threadParams,
      }
      let stored = this.persistent && await savedThread(spec.stateFile)
      const response = stored
        ? await client.rpc('thread/resume',{...params,threadId:stored,excludeTurns:true})
        : await client.rpc('thread/start',{...params,ephemeral:!this.persistent,dynamicTools})
      const threadId = response.thread?.id
      if (!threadId || typeof threadId !== 'string' || (stored && threadId !== stored)) throw Error('Invalid Codex thread identity')
      if (this.#stopping) return
      this.#started = true
      this.emit('started')
      if (!this.job.holdFirst) this.deliver(this.job)
      while (!this.#stopping) {
        const item = await this.#incoming.promise
        this.#incoming = Promise.withResolvers()
        this.#queued = false
        if (this.#stopping) break
        this.#active = item
        const fields = {id:item.id,workerId:this.job.id}
        try {
          if (item.method === 'agent.getHistory') {
            if (!this.persistent) throw Error('History requires a persistent Codex APP')
            const result = await history(client,threadId,item.data,stored)
            if (!this.#stopping && this.#cancelled !== item.id) this.emit('reply',{...fields,result})
          } else if (item.method === 'agent.interrupt') {
            throw Error('No active Codex turn')
          } else if (this.#cancelled !== item.id) {
            const {params:request,validate} = turnRequest(threadId,item,settings.effort)
            const record = await client.turn(request,async () => {
              if (this.#cancelled === item.id) this.#interrupt()
              if (this.persistent && !stored) {
                await saveThread(spec.stateFile,threadId)
                stored = threadId
              }
            }).catch(error => {
              // An absent acknowledgement leaves the remote turn's state unknown.
              // Retiring the worker prevents a second turn entering that thread.
              this.stop(error.message)
              throw error
            })
            if (this.#cancelled !== item.id && !this.#stopping) {
              if (record.status !== 'completed') throw Error('Codex turn did not complete (' + record.status + ')')
              if (item.method) this.emit('reply',{...fields,result:resultOf(record.text,validate)})
            }
          }
        } catch (error) {
          if (!this.#stopping && this.#cancelled !== item.id) {
            if (!item.method) throw error
            this.emit('reply',{...fields,error:{message:error.message}})
          }
        } finally {
          clearTimeout(this.#cancelTimer)
          this.#cancelTimer = undefined
          this.#active = undefined
          this.#cancelled = undefined
        }
        if (!this.#stopping) this.emit('written',fields)
        if (this.#outgoing.size) this.stop()
        if (!this.persistent) break
      }
    } catch (error) {
      if (!this.#stopping) this.#issue ??= error.code ? 'Codex worker storage or runtime unavailable' : error.message
      permanent = !this.#started && !this.#stopping
    } finally {
      clearTimeout(lifetime)
      this.#stopping = true
      const stopped = await this.#client?.close()
      if (stopped === false) this.#issue = 'Codex executor stop could not be confirmed'
      else {
        try { await spec?.cleanup() } catch { this.#issue ??= 'Codex worker cleanup failed' }
      }
      this.emit('exit',{...(this.#issue && {issue:this.#issue}),...(!this.#started && this.#issue && {startFailed:true}),
        ...(permanent && {permanent:true}),...(stopped === false && {stopFailed:true})})
    }
  }
}

export class RunnerHost {
  #workers = new Map()
  #closing = false

  constructor(config,prepare,emit) {
    this.config = config
    this.prepare = prepare
    this.emit = emit
  }

  receive(message) {
    const {type,job,id} = message
    if (type === 'dispatch') {
      const conflict = job.mode === 'persistent' && [...this.#workers.values()].some(w => w.persistent && w.job.appId === job.appId)
      if (this.#closing || this.#workers.has(job.id) || conflict) {
        this.emit('exit',{appId:job.appId,id:job.id,startFailed:true,issue:'Codex worker already active or closing'})
        return
      }
      const worker = new Worker(job,this.emit)
      this.#workers.set(job.id,worker)
      worker.done = worker.run(this.config,this.prepare).finally(() => this.#workers.delete(job.id))
      return
    }
    const worker = this.#workers.get(id)
    if (!worker) return
    if (type === 'deliver') worker.deliver(message.item)
    if (type === 'stop') worker.stop()
    if (type === 'response') worker.respond(message.requestId,message.response)
    if (type === 'notify' && typeof message.notification?.cancelled === 'string') worker.cancel(message.notification.cancelled)
    if (type === 'notify' && typeof message.notification?.interrupt === 'string') void worker.interrupt(message.notification.interrupt)
    if (type === 'reject' && message.message !== 'Call closed') {
      worker.emit('reply',{workerId:id,id:message.callId,error:{message:message.message}})
    }
  }

  async close() {
    this.#closing = true
    const workers = [...this.#workers.values()]
    for (const worker of workers) worker.stop()
    await Promise.all(workers.map(worker => worker.done))
  }
}
