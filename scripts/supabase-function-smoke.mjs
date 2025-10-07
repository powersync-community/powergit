#!/usr/bin/env node
import { exit } from 'node:process'

const validUnauthorizedStatuses = new Set([401, 403])

function parseArgs(argv) {
  const args = { requireVerify: false, payload: '{"remoteUrl":"powersync::https://example.com/orgs/demo/repos/infra"}' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token === '--') continue
    switch (token) {
      case '--url':
      case '-u':
        args.url = argv[++i]
        break
      case '--function':
      case '-f':
        args.functionName = argv[++i]
        break
      case '--auth':
      case '-a':
        args.authKey = argv[++i]
        break
      case '--payload':
      case '-p':
        args.payload = argv[++i]
        break
      case '--require-verify':
        args.requireVerify = true
        break
      case '--skip-unauthorized-check':
        args.skipUnauthorizedCheck = true
        break
      case '--method':
      case '-X':
        args.method = argv[++i]
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        if (!args.url) {
          args.url = token
        } else if (!args.functionName) {
          args.functionName = token
        }
        break
    }
  }
  return args
}

function printHelp() {
  console.log(`Supabase Functions smoke test\n\nUsage:\n  node scripts/supabase-function-smoke.mjs --url <functions-url> --auth <service-role-key> [options]\n\nOptions:\n  --function, -f             Function name (default: powersync-remote-token)\n  --payload, -p              JSON payload string (default: '{"remoteUrl":"powersync::https://example.com/orgs/demo/repos/infra"}')\n  --method, -X               HTTP method (default: POST if payload given, GET otherwise)\n  --require-verify           Fail if unauthenticated call does not return 401/403\n  --skip-unauthorized-check  Skip the unauthenticated call entirely\n  --help, -h                 Show this message\n\nExamples:\n  node scripts/supabase-function-smoke.mjs \\\n    --url http://127.0.0.1:55431/functions/v1 \\\n    --auth "$SUPABASE_SERVICE_ROLE_KEY" \\\n    --require-verify\n\n  pnpm supabase:smoke -- --url https://xyz.supabase.co/functions/v1 --auth $SUPABASE_SERVICE_ROLE_KEY`)
}

async function sendRequest(endpoint, { method, payload, headers = {} }) {
  const init = { method, headers }
  if (payload !== undefined) {
    init.body = payload
  }
  return fetch(endpoint, init)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    return
  }

  if (!args.url) {
    console.error('Missing --url (functions base URL).')
    printHelp()
    exit(1)
  }

  const functionName = args.functionName || 'powersync-remote-token'
  const method = args.method || (args.payload ? 'POST' : 'GET')
  const endpoint = new URL(functionName, args.url.replace(/\/$/, '/') + '/')

  console.log(`→ Testing ${endpoint.href}`)

  if (!args.skipUnauthorizedCheck) {
    const res = await sendRequest(endpoint, {
      method,
      payload: args.payload,
      headers: { 'Content-Type': 'application/json' },
    })

    if (args.requireVerify) {
      if (!validUnauthorizedStatuses.has(res.status)) {
        console.error(`✗ Expected 401/403 when unauthenticated (verify_jwt on), got ${res.status}`)
        const body = await res.text()
        console.error(body)
        exit(1)
      } else {
        console.log(`✓ verify_jwt enforced (status ${res.status})`)
      }
    } else {
      console.log(`ℹ unauthenticated call returned status ${res.status}`)
    }
  }

  if (!args.authKey) {
    console.warn('⚠️  Skipping authenticated request because no --auth key provided.')
    return
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.authKey}`,
  }

  const authedResponse = await sendRequest(endpoint, {
    method,
    payload: args.payload,
    headers: authHeaders,
  })

  const authedBodyText = await authedResponse.text()
  const contentType = authedResponse.headers.get('content-type') || ''
  const maybeJson = contentType.includes('application/json')
  const body = maybeJson && authedBodyText ? JSON.parse(authedBodyText) : authedBodyText

  if (!authedResponse.ok) {
    console.error(`✗ Authenticated request failed with status ${authedResponse.status}`)
    console.error(body)
    exit(1)
  }

  console.log('✓ Authenticated request succeeded')
  if (maybeJson) {
    console.log(JSON.stringify(body, null, 2))
  } else if (authedBodyText) {
    console.log(authedBodyText)
  }
}

main().catch((error) => {
  console.error('Unexpected error running smoke test:')
  console.error(error)
  exit(1)
})
