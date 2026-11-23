const string = {type:'string'}
const filter = {anyOf:[string,{type:'array',items:string}]}
const timeoutMs = {type:'integer',minimum:1,maximum:86400000}
const definitions = [
  ['discover','List workspace nodes visible to this APP.',{},[]],
  ['help','Read the public contract of a visible node.',{node:string,
    features:{anyOf:[...filter.anyOf,{const:true}]}, description:{type:'boolean'}, schema:{type:'boolean'}, doc:{type:'boolean'}},['node']],
  ['call','Call a permitted method on a pappai node.',{node:string,method:string,data:{},version:string,timeoutMs},['node','method']],
  ['publish','Publish a declared event as this APP.',{event:string,data:{},version:string,to:filter,
    delivery:{enum:['none','status']},timeoutMs},['event']],
]

export const dynamicTools = definitions.map(([name,description,properties,required]) => ({
  type:'function',name:'pappai_' + name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
}))
export const toolMethods = new Map(definitions.map(([name]) => ['pappai_' + name,name]))
