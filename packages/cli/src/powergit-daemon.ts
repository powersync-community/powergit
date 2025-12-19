#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

async function main() {
  const entry = require.resolve('@powersync-community/powergit-daemon')
  const args = process.argv.slice(2)

  const child = spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })

  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
