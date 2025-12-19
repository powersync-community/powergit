const isGlobal =
  process.env.npm_config_global === 'true' ||
  process.env.npm_config_location === 'global' ||
  process.env.npm_config_global === '1'

if (!isGlobal) {
  process.exit(0)
}

const message = [
  '',
  '[powergit] Installed CLI + Git remote helper.',
  '',
  'Binaries:',
  '  - powergit',
  '  - powergit-daemon',
  '  - git-remote-powergit',
  '',
  "If you installed globally but the commands aren't found, add your package manager's global bin dir to PATH:",
  '  - npm:   npm bin -g',
  '  - pnpm:  pnpm bin -g',
  '  - yarn:  yarn global bin',
  '',
  'Quick check:',
  '  powergit --help',
  '',
].join('\n')

// eslint-disable-next-line no-console
console.log(message)
