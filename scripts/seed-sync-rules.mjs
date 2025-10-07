#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')
const yamlPath = resolve(repoRoot, 'supabase', 'powersync', 'config.yaml')

const defaultDbPort = process.env.SUPABASE_DB_PORT || '55432'
const defaultDbUrl = `postgres://postgres:postgres@127.0.0.1:${defaultDbPort}/postgres`

const supabaseDbUrl =
  process.env.POWERSYNC_DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.SUPABASE_DB_CONNECTION_STRING ||
  process.env.DATABASE_URL ||
  defaultDbUrl

const { Client } = require('pg')

const REQUIRED_TABLES = ['refs', 'commits', 'file_changes', 'git_packs']

async function fileExists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    )
  }

  return value
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value))
}

function transformRule(rule, index, explicitStream) {
  const stream = typeof explicitStream === 'string' && explicitStream.length > 0 ? explicitStream : rule?.stream
  const label = explicitStream ?? `sync_rules[${index}]`
  if (!stream || typeof stream !== 'string') {
    throw new Error(`${label}.stream must be a non-empty string`)
  }

  const tableName =
    typeof rule?.table === 'string'
      ? rule.table
      : typeof rule?.source?.table === 'string'
        ? rule.source.table
        : null

  if (!tableName) {
  throw new Error(`${label} must specify a table (table or source.table)`)
  }

  const ruleConfig = rule?.rule && typeof rule.rule === 'object' ? { ...rule.rule } : {}

  if (rule.filter && typeof rule.filter === 'object') {
    ruleConfig.filter = rule.filter
  }

  if (ruleConfig.filter == null) {
  throw new Error(`${label} must specify a filter (filter or rule.filter)`)
  }

  return {
    stream,
    tableName,
    rule: sortKeys(ruleConfig),
    ruleHash: stableStringify(ruleConfig),
  }
}

async function loadYamlRules() {
  if (!(await fileExists(yamlPath))) {
    throw new Error(`Missing PowerSync config at ${yamlPath}`)
  }

  const yamlContents = await fs.readFile(yamlPath, 'utf8')
  const parsed = YAML.parse(yamlContents)

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('PowerSync config is empty or invalid YAML')
  }

  const rawRules = parsed.sync_rules

  if (Array.isArray(rawRules)) {
    if (rawRules.length === 0) {
      throw new Error('PowerSync config must define at least one sync rule under sync_rules')
    }
    return rawRules.map((rule, index) => transformRule(rule, index))
  }

  if (rawRules && typeof rawRules === 'object') {
    const entries = Object.entries(rawRules)
    if (entries.length === 0) {
      throw new Error('PowerSync config must define at least one sync rule under sync_rules')
    }
    return entries.map(([stream, rule], index) => {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`sync_rules entry ${stream} must be an object`)
      }
      return transformRule(rule, index, stream)
    })
  }

  throw new Error('PowerSync config sync_rules must be an array or map of stream definitions')
}

async function verifyRequiredTables(client) {
  const missing = []
  for (const table of REQUIRED_TABLES) {
    const { rows } = await client.query('SELECT to_regclass($1) AS reg', [`public.${table}`])
    const exists = rows?.[0]?.reg != null
    if (!exists) {
      missing.push(table)
    }
  }

  if (missing.length > 0) {
    const migrationHint = 'supabase/migrations/20241007090000_powersync_git_tables.sql'
    throw new Error(
      `Missing PowerSync tables: ${missing.join(', ')}. Run "supabase db push" to apply ${migrationHint} before seeding.`,
    )
  }
}

async function run() {
  const rules = await loadYamlRules()
  const desired = new Map(
    rules.map(({ stream, tableName, rule, ruleHash }) => [stream, { stream, tableName, rule, ruleHash }]),
  )
  const client = new Client({ connectionString: supabaseDbUrl })
  await client.connect()

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS powersync')
    await client.query(`
      CREATE TABLE IF NOT EXISTS powersync.streams (
        stream text PRIMARY KEY,
        table_name text NOT NULL,
        rule jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    await verifyRequiredTables(client)

    await client.query('BEGIN')

    const existingRows = await client.query('SELECT stream, table_name AS tableName, rule FROM powersync.streams')
    const existing = new Map(
      existingRows.rows.map(({ stream, tableName, rule }) => [
        stream,
        {
          stream,
          tableName,
          rule,
          ruleHash: stableStringify(rule ?? {}),
        },
      ]),
    )

    const upserts = []
    for (const [stream, spec] of desired.entries()) {
      const current = existing.get(stream)
      if (!current || current.tableName !== spec.tableName || current.ruleHash !== spec.ruleHash) {
        upserts.push(spec)
      }
      existing.delete(stream)
    }

    const deletes = Array.from(existing.keys())

    for (const { stream, tableName, rule } of upserts) {
      await client.query(
        `insert into powersync.streams (stream, table_name, rule)
         values ($1, $2, $3::jsonb)
         on conflict (stream) do update set
           table_name = excluded.table_name,
           rule = excluded.rule,
           updated_at = now()`,
        [stream, tableName, rule],
      )
    }

    if (deletes.length > 0) {
      await client.query('DELETE FROM powersync.streams WHERE stream = ANY($1)', [deletes])
    }

    await client.query('COMMIT')
    if (upserts.length > 0) {
      console.log(`✅ Applied ${upserts.length} PowerSync stream ${upserts.length === 1 ? 'update' : 'updates'} from ${yamlPath}.`)
    } else {
      console.log('ℹ️ PowerSync stream definitions already up to date.')
    }
    if (deletes.length > 0) {
      console.log(`🗑️ Removed ${deletes.length} stale stream ${deletes.length === 1 ? 'entry' : 'entries'}: ${deletes.join(', ')}`)
    }
    console.log('✅ PowerSync Git tables verified (refs, commits, file_changes).')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

run().catch((error) => {
  console.error('❌ Failed to seed PowerSync streams:', error)
  process.exit(1)
})
