#!/usr/bin/env node
import { addPowerSyncRemote } from './index.js';
const [,, cmd, ...rest] = process.argv;
async function main() {
  if (cmd === 'remote' && rest[0] === 'add' && rest[1] === 'powersync') {
    const url = rest[2];
    const name = process.env.REMOTE_NAME || 'origin';
    if (!url) {
      console.error('Usage: psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>');
      process.exit(2);
    }
    await addPowerSyncRemote(process.cwd(), name, url);
    console.log(`Added PowerSync remote (${name}):`, url);
  } else {
    console.log('psgit commands:');
    console.log('  psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
