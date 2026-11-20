import { extractEditable } from '../worker/src/html.js';
import fs from 'fs';
const out = {};
for (const p of process.argv.slice(2)) out[p] = extractEditable(fs.readFileSync('../' + p, 'utf8'), p);
fs.writeFileSync('/tmp/regions.json', JSON.stringify(out));
for (const [p, r] of Object.entries(out)) console.log(p, r.template, r.protectedCount, r.body.length);
