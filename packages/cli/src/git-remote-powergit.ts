#!/usr/bin/env node

async function main() {
  const { runHelper } = await import('@powersync-community/powergit-remote-helper')
  await runHelper()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
