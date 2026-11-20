import { composeEditable, parse } from '../worker/src/html.js';
import fs from 'fs';
const out = JSON.parse(fs.readFileSync('/tmp/roundtrip_out.json','utf8'));
function canon(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g,' ');
  if (node.nodeType === 8) return '';
  if (node.nodeType !== 1) return '';
  const attrs = [...node.attributes].map(a=>`${a.name}="${a.value.trim()}"`).sort().join(' ');
  return `<${node.tagName.toLowerCase()}${attrs?' '+attrs:''}>${[...node.childNodes].map(canon).join('')}</${node.tagName.toLowerCase()}>`.replace(/ +/g,' ').replace(/> </g,'><').replace(/ <\//g,'</');
}
let fails = 0;
for (const [p, body] of Object.entries(out)) {
  const orig = fs.readFileSync('../'+p,'utf8');
  let next; try { next = composeEditable(orig, p, { body }); } catch(e) { console.log('FAIL', p, e.message); fails++; continue; }
  const a = canon(parse(orig).documentElement), b = canon(parse(next).documentElement);
  if (a === b) { console.log('OK  ', p); continue; }
  fails++;
  let i=0; while (a[i]===b[i]) i++;
  console.log('DIFF', p, '\n  orig:', a.slice(Math.max(0,i-120), i+160), '\n  new :', b.slice(Math.max(0,i-120), i+160));
}
process.exit(fails?1:0);
