// Offline upgrade for the rollout headers and optional tool index of Codex CLI 0.170.0.
import { createReadStream } from 'node:fs'
import { lstat, open, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { dynamicTools } from '../src/tools.mjs'

const replacements = new Map(['pappai_discover','pappai_help'].map(name => [
  name === 'pappai_discover' ? 'pappai_dir' : name, dynamicTools.find(tool => tool.name === name),
]))

async function upgradeRollout(file) {
  // Preserve the conversation byte for byte after the session metadata line.
  let header = Buffer.alloc(0)
  const chunk = Buffer.alloc(16384)
  const input = await open(file,'r')
  let end
  try {
    while ((end = header.indexOf(10)) < 0) {
      const {bytesRead} = await input.read(chunk)
      if (!bytesRead || header.length > 4 * 1024 * 1024) throw Error('Invalid rollout metadata')
      header = Buffer.concat([header,chunk.subarray(0,bytesRead)])
    }
  } finally { await input.close() }
  const record = JSON.parse(header.subarray(0,end))
  const tools = record.payload?.dynamic_tools
  if (record.type !== 'session_meta') throw Error('Expected session metadata')
  if (!tools?.some(tool => tool.name === 'pappai_dir' && !tool.namespace)) return 0
  for (const [name, replacement] of replacements) {
    const tool = tools.find(tool => tool.name === name && !tool.namespace)
    if (!tool) throw Error('Incomplete thread tool catalog')
    Object.assign(tool,replacement)
  }
  const temporary = join(dirname(file),'.upgrade-' + randomUUID())
  const target = await open(temporary,'wx',0o600)
  try {
    await target.writeFile(JSON.stringify(record) + '\n')
    await pipeline(createReadStream(file,{start:end+1}),target.createWriteStream())
    await rename(temporary,file)
  } finally { await target.close(); await rm(temporary,{force:true}) }
  return 1
}

export async function upgradeThreadTools(state) {
  const sessions = join(state,'sessions')
  let updated = 0
  for (const item of await readdir(sessions,{recursive:true,withFileTypes:true})) {
    if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name))
      updated += await upgradeRollout(join(item.parentPath,item.name))
  }
  const file = join(state,'sqlite','state_5.sqlite')
  if (!(await lstat(file)).isFile()) throw Error('Expected an existing Codex state database')
  const db = new DatabaseSync(file)
  try {
    db.exec('BEGIN IMMEDIATE')
    const legacy = db.prepare("SELECT thread_id FROM thread_dynamic_tools WHERE name='pappai_dir' AND namespace IS NULL").all()
    const update = db.prepare('UPDATE thread_dynamic_tools SET name=?, description=?, input_schema=? WHERE thread_id=? AND name=? AND namespace IS NULL')
    for (const {thread_id} of legacy) {
      for (const [oldName, tool] of replacements) {
        if (update.run(tool.name,tool.description,JSON.stringify(tool.inputSchema),thread_id,oldName).changes !== 1)
          throw Error('Unexpected persistent thread tool catalog')
      }
    }
    db.exec('COMMIT')
    return updated
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log('Updated persistent tool catalogs:', await upgradeThreadTools(process.argv[2]))
