import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {pool} from '../server/src/db.js';
const base=process.env.SLOTBOOK_URL||'http://localhost:3000';
const attempts=Number(process.argv.includes('--attempts')?process.argv[process.argv.indexOf('--attempts')+1]:50);
if(!Number.isInteger(attempts)||attempts<2||attempts>200)throw new Error('attempts must be 2..200');
const event=await pool.query(`SELECT id FROM event_types WHERE slug='interview' LIMIT 1`);
if(!event.rows[0])throw new Error('Seed demo host first');
let slot:string|undefined;
for(let i=1;i<30;i++) {
 const d=new Date(Date.now()+i*86400000).toISOString().slice(0,10);
 const resp=await fetch(`${base}/api/hosts/demo-ny/events/interview/slots?from=${d}&to=${d}&tz=UTC`);
 if(!resp.ok)throw new Error(`Availability API returned ${resp.status}`);
 const slots=(await resp.json() as {slots:{start_at:string}[]}).slots;
 if(slots.length){slot=slots[0].start_at;break;}
}
if(!slot)throw new Error('No free slots; use a clean test database or another future date');
const statuses=await Promise.all(Array.from({length:attempts},()=>fetch(`${base}/api/holds`,{
 method:'POST',headers:{'content-type':'application/json','Idempotency-Key':randomUUID()},
 body:JSON.stringify({event_id:event.rows[0].id,start_at:slot})
}).then(x=>x.status).catch(()=>0)));
const counts:Record<number,number>={};for(const status of statuses)counts[status]=(counts[status]||0)+1;
const count=await pool.query(`SELECT count(*)::int AS n FROM bookings b JOIN booking_sessions s ON s.id=b.session_id
 WHERE s.event_type_id=$1 AND s.start_at=$2 AND b.status IN ('held','confirmed')`,[event.rows[0].id,slot]);
const ok=counts[201]===1&&counts[409]===attempts-1&&count.rows[0].n===1;
const evidence={result:ok?'PASS':'FAIL',utc_timestamp:new Date().toISOString(),host:'demo-ny',event:'interview',start_at:slot,attempts,statuses:counts,persisted_active_bookings:count.rows[0].n};
mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/concurrency_result.json',JSON.stringify(evidence,null,2));
console.log(`RESULT: ${ok?'PASS':'FAIL'} ${JSON.stringify(counts)} | active rows: ${count.rows[0].n}`);
console.log('Evidence: docs/evidence/concurrency_result.json');
await pool.end();if(!ok)process.exitCode=1;
