#!/usr/bin/env node
import { runHelper } from './index.js';
runHelper().catch(e => { console.error(e); process.exit(1); });
