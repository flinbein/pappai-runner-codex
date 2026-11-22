import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const log = process.argv[2]
let threadId, turnId, sessionLogin
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const complete = status => send({method:'turn/completed', params:{threadId, turn:{id:turnId,status,items:[]}}})
for await (const line of createInterface({input:process.stdin})) {
  const {method,id,params,result} = JSON.parse(line)
  if (!method) {
    if (id === 'dynamic') {
      send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text:result.contentItems[0].text}}})
      complete('completed')
    }
    if (id === 'refresh') {
      if (result?.accessToken !== 'refreshed') throw Error('wrong refresh')
      send({id:sessionLogin,result:{type:'chatgptAuthTokens'}})
    }
    continue
  }
  appendFileSync(log, JSON.stringify({method,params,pid:process.pid}) + '\n')
  const ok = result => send({id,result})
  if (method === 'initialize') ok({userAgent:'codex/0.170.0 (fixture)'})
  if (method === 'account/read') ok({account:{type:'apiKey'}})
  if (method === 'account/login/start') {
    if (params.type !== 'chatgptAuthTokens' || params.accessToken !== 'initial') throw Error('wrong login')
    sessionLogin=id
    send({method:'account/chatgptAuthTokens/refresh',id:'refresh',params:{reason:'unauthorized',previousAccountId:'work'}})
  }
  if (method === 'thread/start') { threadId=randomUUID(); ok({thread:{id:threadId}}) }
  if (method === 'thread/resume') {
    threadId=params.threadId
    if (!readFileSync(log,'utf8').includes('"accepted":"' + threadId + '"')) {
      send({id,error:{code:-32000,message:'missing history'}})
    } else ok({thread:{id:threadId}})
  }
  if (method === 'thread/items/list') {
    if (params.threadId !== threadId) throw Error('wrong history')
    ok({nextCursor:'next-page',data:[
      {item:{type:'userMessage',content:[{type:'text',text:'hello'},{type:'text',text:'private framing'}]}},
      {item:{type:'agentMessage',phase:'commentary',text:'private commentary'}},
      {item:{type:'agentMessage',phase:'final_answer',text:'world'}},
      {item:{type:'dynamicToolCall',contentItems:[{type:'inputText',text:'tool secret'}]}},
    ]})
  }
  if (method === 'turn/start') {
    if (params.threadId !== threadId) throw Error('wrong thread')
    appendFileSync(log, JSON.stringify({accepted:threadId}) + '\n')
    turnId=randomUUID()
    const record=JSON.parse(params.input[0].text)
    const data=record.data
    if (data === 'exit') process.exit(19)
    const reply=data === 'invalid' ? '{"result":"wrong"}' : data === 'malformed' ? '{' :
      params.outputSchema ? '{"result":7}' : 'reply-' + record.data
    if (data === 'tool') {
      send({method:'item/tool/call',id:'dynamic',params:{threadId,turnId,tool:'pappai_call',callId:'tool-1',
        arguments:{node:'target',method:'read',data:1}}})
    } else if (data !== 'hold') {
      // Real app-server can publish items before returning the start response.
      send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'m1',phase:'commentary',text:'intermediate'}}})
      if (data !== 'empty') send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'m2',phase:'final_answer',text:reply}}})
      complete(data === 'failed' ? 'failed' : 'completed')
    }
    ok({turn:{id:turnId,status:'inProgress',items:[]}})
  }
  if (method === 'turn/interrupt') { complete('interrupted'); ok({}) }
}
