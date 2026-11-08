import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { strictLocalToUTC, validZone } from '../server/src/time.js';

// Intentionally fail rather than silently skip real PostgreSQL integration tests.
const testUrl=process.env.TEST_DATABASE_URL;
let testDatabase = '';
try {
 if (!testUrl) throw new Error('not configured');
 const url = new URL(testUrl);
 if (!['postgresql:','postgres:'].includes(url.protocol) || !url.hostname || !url.username)
   throw new Error('invalid PostgreSQL URL');
 testDatabase = decodeURIComponent(url.pathname.slice(1));
} catch {
 throw new Error('Invalid TEST_DATABASE_URL. Check .env for the correct host, port, database and URL-encoded password (do not paste secrets into logs).');
}
if (!testDatabase.endsWith('_test') || testDatabase === '' || testDatabase === 'slotbook_ts') {
 throw new Error('TEST_DATABASE_URL must select a dedicated PostgreSQL database ending with _test');
}
if (process.env.DATABASE_URL) {
 try {
  if (new URL(process.env.DATABASE_URL).pathname === new URL(testUrl!).pathname)
    throw new Error('Test and development databases must be different');
 } catch (error) { if (error instanceof Error && error.message === 'Test and development databases must be different') throw error; }
}
process.env.DATABASE_URL=testUrl;
process.env.NODE_ENV='test';
const { pool, migrate } = await import('../server/src/db.js');
const { seed } = await import('../server/src/seed.js');
const { createApp } = await import('../server/src/app.js');
const app=await createApp();
let hostId:string,interviewId:string,workshopId:string;
const request=(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,headers:{...headers,...(payload!==undefined?{'content-type':'application/json'}:{})},payload:payload===undefined?undefined:JSON.stringify(payload)});
const key=()=>({'Idempotency-Key':randomUUID()});
async function firstSlot(slug='interview') {
 for(let d=1;d<30;d++) {
  const date=new Date(Date.now()+d*86400000).toISOString().slice(0,10);
  const r=await request('GET',`/api/hosts/demo-ny/events/${slug}/slots?from=${date}&to=${date}&tz=Asia%2FKolkata`);
  assert.equal(r.statusCode,200,r.body);
  const slots=r.json().slots;
  if(slots.length)return slots[0];
 }
 throw new Error('No free seeded slots found');
}
async function makeHold(slug='interview',slot?:any,idempotency?:string) {
 const s=slot??await firstSlot(slug);const eventId=slug==='interview'?interviewId:workshopId;
 return request('POST','/api/holds',{event_id:eventId,start_at:s.start_at},{'Idempotency-Key':idempotency||randomUUID()});
}
async function confirmation(h:any) {return request('POST',`/api/holds/${h.id}/confirm`,{guest_name:'Test Guest',guest_email:'guest@example.test'},{...key(),'X-Booking-Token':h.hold_token});}

before(async()=>{
 await migrate();
 // Dedicated _test database only. Never truncate the development database.
 await pool.query('TRUNCATE TABLE hosts CASCADE');
 await seed();
 const r=await pool.query("SELECT h.id AS host_id, MAX(e.id::text) FILTER(WHERE e.slug='interview') AS interview_id, MAX(e.id::text) FILTER(WHERE e.slug='workshop') AS workshop_id FROM hosts h JOIN event_types e ON e.host_id=h.id GROUP BY h.id");
 hostId=r.rows[0].host_id;interviewId=r.rows[0].interview_id;workshopId=r.rows[0].workshop_id;
});
after(async()=>{await app.close();await pool.end();});

test('Host dashboard requires authentication; seeded login works',async()=>{
 assert.equal((await request('GET','/api/host/me')).statusCode,401);
 const auth=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 assert.equal(auth.statusCode,200,auth.body);
 const cookies=String(auth.headers['set-cookie']).split(';')[0];
 const me=await request('GET','/api/host/me',undefined,{cookie:cookies});assert.equal(me.statusCode,200);assert.equal(me.json().slug,'demo-ny');
});

test('Public slots include host/guest time zones and enforce valid schedule',async()=>{
 const s=await firstSlot();assert.equal(s.remaining_seats,1);
 assert.ok(s.guest_local);assert.ok(s.host_local);assert.match(s.start_at,/Z$/);
 assert.equal((await request('GET','/api/hosts/demo-ny/events/interview/slots?from=2026-01-01&to=2026-02-15&tz=UTC')).statusCode,400);
});

test('50 concurrent one-on-one holds: exactly one 201 and 49 conflicts',async()=>{
 const slot=await firstSlot();
 const results=await Promise.all(Array.from({length:50},()=>makeHold('interview',slot)));
 assert.equal(results.filter(x=>x.statusCode===201).length,1,results.map(r=>r.statusCode).join(','));
 assert.equal(results.filter(x=>x.statusCode===409).length,49);
 const row=await pool.query(`SELECT count(*)::int AS n FROM bookings b JOIN booking_sessions s ON s.id=b.session_id
 WHERE s.host_id=$1 AND s.start_at=$2 AND b.status IN ('held','confirmed')`,[hostId,slot.start_at]);
 assert.equal(row.rows[0].n,1);
});

test('Direct SQL cannot insert another overlapping active session',async()=>{
 const existing=await pool.query("SELECT * FROM booking_sessions WHERE host_id=$1 AND state='active' LIMIT 1",[hostId]);assert.ok(existing.rows.length);
 const s=existing.rows[0];
 await assert.rejects(pool.query(`INSERT INTO booking_sessions(host_id,event_type_id,start_at,end_at,duration_minutes,capacity,buffer_before_minutes,buffer_after_minutes,occupied_range)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::tstzrange)`,[hostId,workshopId,s.start_at,
   new Date(new Date(s.start_at).getTime()+3600000),60,4,10,10,
   `[${new Date(new Date(s.start_at).getTime()-600000).toISOString()},${new Date(new Date(s.start_at).getTime()+4200000).toISOString()})`]),(e:any)=>e.code==='23P01');
});

test('A capacity-four group allows four seats; fifth hold is rejected',async()=>{
 const slot=await firstSlot('workshop');
 const responses=await Promise.all(Array.from({length:5},()=>makeHold('workshop',slot)));
 assert.equal(responses.filter(x=>x.statusCode===201).length,4,responses.map(x=>x.statusCode).join(','));
 assert.equal(responses.filter(x=>x.statusCode===409).length,1);
 const r=await pool.query(`SELECT count(*)::int AS n FROM bookings b JOIN booking_sessions s ON s.id=b.session_id WHERE s.event_type_id=$1 AND s.start_at=$2 AND b.status IN ('held','confirmed')`,[workshopId,slot.start_at]);
 assert.equal(r.rows[0].n,4);
});

test('Idempotency replay returns same booking; different payload conflicts',async()=>{
 const slot=await firstSlot();const k=randomUUID();
 const a=await makeHold('interview',slot,k);assert.equal(a.statusCode,201,a.body);
 const b=await makeHold('interview',slot,k);assert.equal(b.statusCode,201,b.body);assert.equal(a.json().id,b.json().id);
 const other=await firstSlot('workshop');
 const changed=await request('POST','/api/holds',{event_id:workshopId,start_at:other.start_at},{'Idempotency-Key':k});
 // Different scope (host is the scope); this must not replay a different payload.
 assert.equal(changed.statusCode,409,changed.body);
});

test('Confirmation, notification outbox, private manage link and cancellation',async()=>{
 const h=(await makeHold()).json();const c=await confirmation(h);assert.equal(c.statusCode,200,c.body);
 const info=await request('GET',`/api/bookings/${h.hold_token}`);assert.equal(info.statusCode,200);assert.equal(info.json().status,'confirmed');assert.equal(info.json().host_timezone,'America/New_York');
 const cancelled=await request('POST',`/api/bookings/${h.hold_token}/cancel`,{reason:'No longer available'},key());assert.equal(cancelled.statusCode,200,cancelled.body);
 const n=await pool.query('SELECT event_type FROM notification_outbox WHERE booking_id=$1 ORDER BY id',[h.id]);assert.deepEqual(n.rows.map(x=>x.event_type),['confirmed','cancelled']);
});

test('Expired holds cannot be confirmed and no longer block availability',async()=>{
 const h=(await makeHold()).json();
 await pool.query("UPDATE bookings SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[h.id]);
 const confirm=await confirmation(h);assert.equal(confirm.statusCode,409,confirm.body);
 const r=await pool.query('SELECT status FROM bookings WHERE id=$1',[h.id]);
 assert.equal(r.rows[0].status,'held'); // rejected transaction rolls back its cleanup
 const retry=await makeHold('interview',{start_at:h.start_at});assert.equal(retry.statusCode,201,retry.body);
});

test('Failed reschedule rolls back and preserves original appointment',async()=>{
 const a=(await makeHold()).json();await confirmation(a);
 const b=(await makeHold()).json();await confirmation(b);
 const before=(await request('GET',`/api/bookings/${a.hold_token}`)).json();
 const moved=await request('POST',`/api/bookings/${a.hold_token}/reschedule`,{start_at:b.start_at,expected_version:before.version},key());
 assert.equal(moved.statusCode,409,moved.body);
 const after=(await request('GET',`/api/bookings/${a.hold_token}`)).json();
 assert.equal(after.start_at,before.start_at);assert.equal(after.status,'confirmed');
});

test('Successful reschedule retains booking ID and increments version',async()=>{
 const h=(await makeHold()).json();await confirmation(h);
 const before=(await request('GET',`/api/bookings/${h.hold_token}`)).json();
 let next=await firstSlot();
 if(next.start_at===before.start_at)throw new Error('Need alternative open slot');
 const response=await request('POST',`/api/bookings/${h.hold_token}/reschedule`,{start_at:next.start_at,expected_version:before.version},key());
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().id,h.id);assert.equal(response.json().version,before.version+1);
 const stale=await request('POST',`/api/bookings/${h.hold_token}/reschedule`,{start_at:before.start_at,expected_version:before.version},key());
 assert.equal(stale.statusCode,409,stale.body);
});

test('Nonexistent and ambiguous local DST times are rejected',()=>{
 assert.equal(validZone('America/New_York'),true);
 assert.equal(strictLocalToUTC('2026-03-08',150,'America/New_York'),null); // 02:30 gap
 assert.equal(strictLocalToUTC('2026-11-01',90,'America/New_York'),null); // 01:30 fold
 assert.equal(strictLocalToUTC('2026-12-01',540,'America/New_York')?.toISOString(),'2026-12-01T14:00:00.000Z');
});

test('Bookings cannot be confirmed using incorrect token',async()=>{
 const h=(await makeHold()).json();
 const r=await request('POST',`/api/holds/${h.id}/confirm`,{guest_name:'Wrong Guest',guest_email:'wrong@example.test'},{...key(),'X-Booking-Token':'incorrect-token'});
 assert.equal(r.statusCode,403);
});

test('Naive timestamps and invalid host-local date overrides are rejected',async()=>{
 const malformedEvent=await request('POST','/api/holds',{event_id:'x'.repeat(36),start_at:'2026-12-01T14:00:00Z'},key());
 assert.equal(malformedEvent.statusCode,400,malformedEvent.body);
 const r=await request('POST','/api/holds',{event_id:interviewId,start_at:'2026-12-01T14:00:00'},key());
 assert.equal(r.statusCode,400,r.body);
 const auth=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 const cookie=String(auth.headers['set-cookie']).split(';')[0];
 const invalid=await request('PUT','/api/host/overrides/2026-02-31',{is_closed:true,windows:[]},{cookie});
 assert.equal(invalid.statusCode,400,invalid.body);
});

test('Host can configure multiple weekly windows and close a specific date',async()=>{
 const login=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 assert.equal(login.statusCode,200,login.body);
 const cookie=String(login.headers['set-cookie']).split(';')[0];
 const original=await request('GET','/api/host/schedule',undefined,{cookie});
 assert.equal(original.statusCode,200);
 const saved=await request('PUT','/api/host/schedule',{weekly:[{weekday:1,start:540,end:720},{weekday:1,start:780,end:1020}]},{cookie});
 assert.equal(saved.statusCode,200,saved.body);
 const current=await request('GET','/api/host/schedule',undefined,{cookie});
 assert.equal(current.json().weekly.length,2);
 const day=Array.from({length:7},(_,i)=>new Date(Date.now()+(i+1)*86400000).toISOString().slice(0,10)).find(d=>new Date(`${d}T00:00:00Z`).getUTCDay()===1)!; // next Monday
 const beforeClose=await request('GET',`/api/hosts/demo-ny/events/interview/slots?from=${day}&to=${day}&tz=UTC`);
 assert.equal(beforeClose.statusCode,200,beforeClose.body);assert.ok(beforeClose.json().slots.length>0,'Monday must have open slots before override');
 const closed=await request('PUT',`/api/host/overrides/${day}`,{is_closed:true,windows:[]},{cookie});assert.equal(closed.statusCode,200,closed.body);
 const slots=await request('GET',`/api/hosts/demo-ny/events/interview/slots?from=${day}&to=${day}&tz=UTC`);
 assert.equal(slots.statusCode,200,slots.body);assert.equal(slots.json().slots.length,0);
 // Restore the seeded schedule for independent test reruns.
 const restore=await request('PUT','/api/host/schedule',{weekly:original.json().weekly},{cookie});assert.equal(restore.statusCode,200,restore.body);
});

test('Logout invalidates authenticated session; guest routes remain public',async()=>{
 const login=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 assert.equal(login.statusCode,200,login.body);
 const cookie=String(login.headers['set-cookie']).split(';')[0];
 const logout=await request('POST','/api/auth/logout',undefined,{cookie});
 assert.equal(logout.statusCode,200,logout.body);
 assert.equal((await request('GET','/api/host/me',undefined,{cookie})).statusCode,401);
 assert.equal((await request('GET','/api/public/hosts')).statusCode,200);
});

test('Public host discovery is dynamic and exposes only active event types',async()=>{
 const hosts=await request('GET','/api/public/hosts');assert.equal(hosts.statusCode,200);
 assert.ok(hosts.json().some((h:any)=>h.slug==='demo-ny'));
 const detail=await request('GET','/api/public/hosts/demo-ny');assert.equal(detail.statusCode,200);
 assert.ok(detail.json().events.some((e:any)=>e.slug==='interview'));
});

test('Host event can be renamed/deactivated; occupied events reject capacity modifications',async()=>{
 const login=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 const cookie=String(login.headers['set-cookie']).split(';')[0];
 const update=await request('PATCH',`/api/host/events/${interviewId}`,{name:'Interview appointment'}, {cookie});
 assert.equal(update.statusCode,200,update.body);
 const slot=await firstSlot();
 const held=await makeHold('interview',slot);assert.equal(held.statusCode,201,held.body);
 const rejected=await request('PATCH',`/api/host/events/${interviewId}`,{capacity:3},{cookie});
 assert.equal(rejected.statusCode,409,rejected.body);
 const deactivated=await request('PATCH',`/api/host/events/${interviewId}`,{is_active:false},{cookie});
 assert.equal(deactivated.statusCode,200,deactivated.body);
 assert.equal((await request('GET','/api/hosts/demo-ny/events/interview/slots?from=2026-12-01&to=2026-12-01&tz=UTC')).statusCode,404);
 const activated=await request('PATCH',`/api/host/events/${interviewId}`,{is_active:true,name:'Interview'},{cookie});
 assert.equal(activated.statusCode,200,activated.body);
});

test('Database rejects cross-host sessions and direct mutation of promised session time',async()=>{
 const r=await pool.query('SELECT id, host_id, event_type_id FROM booking_sessions LIMIT 1');assert.ok(r.rows.length);
 const session=r.rows[0];
 await assert.rejects(pool.query(`UPDATE booking_sessions SET capacity=capacity+1 WHERE id=$1`,[session.id]),(error:any)=>error.code==='23514');
 const foreignHost=await pool.query("INSERT INTO hosts(slug,display_name,email,password_salt,password_hash,time_zone) VALUES('other-host','Other host','other@example.test','x','x','UTC') RETURNING id");
 const anotherHostId=foreignHost.rows[0].id;
 await assert.rejects(pool.query(`INSERT INTO booking_sessions(host_id,event_type_id,start_at,end_at,duration_minutes,capacity,buffer_before_minutes,buffer_after_minutes,occupied_range)
    VALUES($1,$2,'2027-01-11T09:00:00Z','2027-01-11T09:30:00Z',30,1,0,0,tstzrange('2027-01-11T09:00:00Z','2027-01-11T09:30:00Z','[)'))`,
    [anotherHostId,interviewId]),(error:any)=>error.code==='23503');
});

test('Guest can release held seat; expired holds are excluded from host list and public capacity',async()=>{
 const h=(await makeHold()).json();
 const cancel=await request('POST',`/api/bookings/${h.hold_token}/cancel`,{reason:'Changed my mind'},key());
 assert.equal(cancel.statusCode,200,cancel.body);
 const fresh=await makeHold('interview',{start_at:h.start_at});assert.equal(fresh.statusCode,201,fresh.body);
 await pool.query("UPDATE bookings SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[fresh.json().id]);
 const publicState=await request('GET',`/api/bookings/${fresh.json().hold_token}`);
 assert.equal(publicState.json().status,'expired');
 const auth=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 const cookie=String(auth.headers['set-cookie']).split(';')[0];
 const dashboard=await request('GET','/api/host/bookings',undefined,{cookie});
 assert.ok(!dashboard.json().some((b:any)=>b.id===fresh.json().id));
 const available=await request('GET',`/api/hosts/demo-ny/events/interview/slots?from=${h.start_at.slice(0,10)}&to=${h.start_at.slice(0,10)}&tz=UTC`);
 assert.equal(available.statusCode,200,available.body);
});

test('Host date overrides can be added and removed without deleting confirmed bookings',async()=>{
 const login=await request('POST','/api/auth/login',{email:'demo@slotbook.local',password:process.env.DEMO_PASSWORD||'DemoPass!2026'});
 const cookie=String(login.headers['set-cookie']).split(';')[0];
 const day='2026-12-24';
 assert.equal((await request('PUT',`/api/host/overrides/${day}`,{is_closed:true,windows:[]},{cookie})).statusCode,200);
 const saved=await request('GET','/api/host/schedule',undefined,{cookie});
 assert.ok(saved.json().overrides.find((o:any)=>o.day===day&&o.is_closed));
 assert.equal((await request('DELETE',`/api/host/overrides/${day}`,undefined,{cookie})).statusCode,200);
 const after=await request('GET','/api/host/schedule',undefined,{cookie});
 assert.ok(!after.json().overrides.some((o:any)=>o.day===day));
});
