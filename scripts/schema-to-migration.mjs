#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const supabaseDir = path.join(repoRoot, 'supabase')
const schemaPath = path.join(supabaseDir, 'schema.sql')
const migrationsDir = path.join(supabaseDir, 'migrations')

function ensureSlug(raw) {
  if (!raw) return 'schema'
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '') || 'schema'
}

function timestamp() {
  const now = new Date()
  const pad = (value) => value.toString().padStart(2, '0')
  const yyyy = now.getUTCFullYear()
  const MM = pad(now.getUTCMonth() + 1)
  const dd = pad(now.getUTCDate())
  const hh = pad(now.getUTCHours())
  const mm = pad(now.getUTCMinutes())
  const ss = pad(now.getUTCSeconds())
  return `${yyyy}${MM}${dd}${hh}${mm}${ss}`
}

async function main() {
  try {
    await access(schemaPath, fsConstants.R_OK)
  } catch (error) {
    console.error(`Schema not found at ${schemaPath}. Did you run this from the repo root?`)
    process.exitCode = 1
    return
  }

  const args = process.argv.slice(2).filter((arg) => arg && arg !== '--')
  let slugArg

  if (args.length > 0) {
    if (args[0] === '--name' || args[0] === '-n') {
      slugArg = args[1]
    } else if (!args[0].startsWith('-')) {
      slugArg = args[0]
    }
  }

  const slug = ensureSlug(slugArg)
  const ts = timestamp()
  const filename = `${ts}_${slug}.sql`
  const destPath = path.join(migrationsDir, filename)

  await mkdir(migrationsDir, { recursive: true })
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(destPath, schema, 'utf8')

  console.log(`Wrote ${destPath}`)
  console.log('You can now run `supabase db push` to apply the migration.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
