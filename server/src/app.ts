import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { pool, ApiError, pgError, one, tx } from './db.js';
import { logIn, requireHost, digest, lockHost } from './auth.js';
import { getEvent, generateSlots, validateWindows } from './slots.js';
import { validZone } from './time.js';
import { hold, confirm, cancel, cancelByHost, reschedule, getManaged, requestKey, expireHost } from './service.js';

const data = (v:unknown) => (!v||typeof v!=='object'||Array.isArray(v) ? {} : v as Record<string,unknown>);
const sval=(v:unknown)=>typeof v==='string'?v.trim():'';
const asInt=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)?v:NaN;
// Single-node demo abuse protection, not a distributed rate limiter.
// Booking correctness remains in Postgres; a multi-node production deployment
// should replace this with centralized limits at the edge.
const limits=new Map<string,{count:number;until:number}>();
export function enforceRateLimit(identity:string,max:number,windowMs:number) {
 if(process.env.NODE_ENV==='test')return;
 const now=Date.now();
 if(limits.size>5000) for(const [k,v] of limits) if(v.until<=now) limits.delete(k);
 const v=limits.get(identity);
 if(!v || v.until<=now){limits.set(identity,{count:1,until:now+windowMs});return;}
 if(v.count>=max)throw new ApiError(429,'RATE_LIMIT','Too many requests. Try again later.');
 v.count++;
}
function uuid(s:string) {if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))throw new ApiError(400,'INVALID_ID','Invalid UUID');return s;}
function reqKey(h:unknown) {return requestKey(h);}
const params=(req:{params:unknown})=>data(req.params);
function param(req:{params:unknown},name:string){return sval(params(req)[name]);}
function checkOrigin(origin:unknown, host:unknown) {
 if(typeof origin==='string'&& typeof host==='string') {
  try {if(new URL(origin).host!==host) throw new ApiError(403,'BAD_ORIGIN','Cross-origin state change denied');}
  catch(e){if(e instanceof ApiError)throw e;throw new ApiError(403,'BAD_ORIGIN','Invalid Origin');}
 }
}
export async function createApp() {
 // Do not log raw URLs: /api/bookings/:token and /manage/:token contain private secrets.
 const app=Fastify({logger:false,bodyLimit:100_000});
 app.addHook('onResponse',async(req,reply)=>{
   if(process.env.NODE_ENV==='test')return;
   console.info(JSON.stringify({event:'http_request',request_id:req.id,method:req.method,
     route:req.routeOptions?.url||'unmatched',status:reply.statusCode}));
 });
 await app.register(cookie);
 app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Referrer-Policy','no-referrer');reply.header('X-Content-Type-Options','nosniff');return payload;});
 app.setErrorHandler((error,req,reply)=>{
  const e=error instanceof ApiError?error:pgError(error);
  if(e) return reply.code(e.status).send({error:e.code,message:e.message});
  const status=(error as {statusCode?:number}).statusCode;
  if (status && status >= 400 && status < 500) return reply.code(status).send({error:'BAD_REQUEST',message:error instanceof Error ? error.message : 'Invalid request'});
  if(process.env.NODE_ENV!=='test')console.error(JSON.stringify({event:'api_error',request_id:req.id,
    error:error instanceof Error?error.name:'UnknownError'}));
  return reply.code(500).send({error:'INTERNAL_ERROR',message:'Request could not be completed'});
 });
 app.addHook('preHandler',async(req)=>{
  if(!['GET','HEAD','OPTIONS'].includes(req.method) &&
     (req.url.startsWith('/api/host/') || req.url.startsWith('/api/auth/')))
    checkOrigin(req.headers.origin,req.headers.host);
  if(req.method==='POST' && req.url==='/api/auth/login')enforceRateLimit(`login:${req.ip}`,10,15*60_000);
  if(req.method==='POST' && req.url==='/api/holds')enforceRateLimit(`hold:${req.ip}`,180,60_000);
  if(req.method==='POST' && (req.url.includes('/confirm')||req.url.includes('/reschedule')))
    enforceRateLimit(`booking:${req.ip}`,60,60_000);
 });
 app.get('/api/health',async()=>({ok:true}));
 app.get('/api/health/ready',async()=>{await pool.query('SELECT 1');return {ok:true,database:'ready'};});
 app.post('/api/auth/login',async(req,reply)=>{
  const b=data(req.body);const {token}=await logIn(sval(b.email),sval(b.password));
  reply.setCookie('slotbook_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:12*3600});
  return {ok:true};
 });
 app.post('/api/auth/logout',async(req,reply)=>{
  const token=req.cookies.slotbook_session;if(token)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[digest(token)]);
  reply.clearCookie('slotbook_session',{path:'/'});return {ok:true};
 });
 app.get('/api/host/me',async(req)=>{
  const id=await requireHost(req);
  return one(pool,'SELECT id,slug,display_name,email,time_zone FROM hosts WHERE id=$1',[id]);
 });
 app.patch('/api/host/me',async(req)=>{
  const id=await requireHost(req);const b=data(req.body);const zone=sval(b.time_zone);
  if(!validZone(zone))throw new ApiError(400,'INVALID_ZONE','Valid IANA time zone required');
  return tx(async db=>{
    await lockHost(db,id);
    const active=await one<{n:string}>(db,`SELECT count(*)::text AS n FROM bookings b
      JOIN booking_sessions s ON s.id=b.session_id
      WHERE s.host_id=$1 AND s.start_at>clock_timestamp() AND
        (b.status='confirmed' OR (b.status='held' AND b.hold_expires_at>clock_timestamp()))`,[id]);
    if(Number(active?.n)>0 && b.acknowledge_existing_bookings!==true)
      throw new ApiError(409,'ACTIVE_BOOKINGS','Existing appointments keep their UTC times. Confirm the time-zone change explicitly.');
    return one(db,'UPDATE hosts SET time_zone=$2 WHERE id=$1 RETURNING id,slug,display_name,email,time_zone',[id,zone]);
  });
 });
 app.get('/api/host/events',async(req)=>{
  const id=await requireHost(req);
  const r=await pool.query('SELECT * FROM event_types WHERE host_id=$1 ORDER BY name',[id]);return r.rows;
 });
 app.post('/api/host/events',async(req,reply)=>{
  const id=await requireHost(req);const b=data(req.body);
  const name=sval(b.name),slug=sval(b.slug);
  if(name.length<3||name.length>100|| !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||slug.length>64)throw new ApiError(400,'INVALID_EVENT','Enter a name and lowercase hyphenated slug');
  const dur=asInt(b.duration_minutes),cap=asInt(b.capacity),bef=asInt(b.buffer_before_minutes??0),aft=asInt(b.buffer_after_minutes??0),notice=asInt(b.minimum_notice_minutes??240),horizon=asInt(b.booking_horizon_days??30);
  if(!(dur>=15&&dur<=120&&cap>=1&&cap<=50&&bef>=0&&bef<=30&&aft>=0&&aft<=30&&notice>=0&&notice<=43200&&horizon>=1&&horizon<=365))throw new ApiError(400,'INVALID_EVENT','Duration 15-120, capacity 1-50, buffers 0-30, notice 0-43200, horizon 1-365');
  const r=await one(pool,`INSERT INTO event_types(host_id,name,slug,duration_minutes,capacity,buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_days)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,name,slug,dur,cap,bef,aft,notice,horizon]);
  reply.code(201);return r;
 });
 app.patch('/api/host/events/:id',async(req)=>{
   const host=await requireHost(req),eventId=uuid(param(req,'id')),b=data(req.body);
   const permitted=['name','duration_minutes','capacity','buffer_before_minutes','buffer_after_minutes','minimum_notice_minutes','booking_horizon_days','is_active'];
   if(Object.keys(b).length===0||Object.keys(b).some(k=>!permitted.includes(k)))
     throw new ApiError(400,'INVALID_EVENT','Provide supported event fields; event slug is immutable');
   return tx(async db=>{
     await lockHost(db,host);
     const existing=await one<Record<string,unknown>>(db,'SELECT * FROM event_types WHERE id=$1 AND host_id=$2',[eventId,host]);
     if(!existing)throw new ApiError(404,'EVENT_NOT_FOUND','Event not found');
     const fields={...existing,...b};
     const name=sval(fields.name),dur=asInt(fields.duration_minutes),cap=asInt(fields.capacity),
       bef=asInt(fields.buffer_before_minutes),aft=asInt(fields.buffer_after_minutes),
       notice=asInt(fields.minimum_notice_minutes),horizon=asInt(fields.booking_horizon_days);
     if(name.length<3||name.length>100||!(dur>=15&&dur<=120&&cap>=1&&cap<=50&&bef>=0&&bef<=30&&aft>=0&&aft<=30&&notice>=0&&notice<=43200&&horizon>=1&&horizon<=365)||typeof fields.is_active!=='boolean')
       throw new ApiError(400,'INVALID_EVENT','Invalid event settings');
     const scheduleFields=['duration_minutes','capacity','buffer_before_minutes','buffer_after_minutes','minimum_notice_minutes','booking_horizon_days'];
     if(scheduleFields.some(k=>b[k]!==undefined&&b[k]!==existing[k])){
       const active=await one<{n:string}>(db,`SELECT count(*)::text AS n FROM booking_sessions s JOIN bookings bk ON bk.session_id=s.id
        WHERE s.event_type_id=$1 AND s.start_at>clock_timestamp() AND
          (bk.status='confirmed' OR (bk.status='held' AND bk.hold_expires_at>clock_timestamp()))`,[eventId]);
       if(Number(active?.n)>0)throw new ApiError(409,'ACTIVE_EVENT_BOOKINGS','Scheduling rules cannot change while this event has future bookings. Create a new event instead.');
     }
     return one(db,`UPDATE event_types SET name=$2,duration_minutes=$3,capacity=$4,buffer_before_minutes=$5,
       buffer_after_minutes=$6,minimum_notice_minutes=$7,booking_horizon_days=$8,is_active=$9
       WHERE id=$1 RETURNING *`,[eventId,name,dur,cap,bef,aft,notice,horizon,fields.is_active]);
   });
 });
 app.get('/api/host/schedule',async(req)=>{
  const id=await requireHost(req);
  const [weekly,overrides]=await Promise.all([
   pool.query('SELECT weekday,start_min AS start,end_min AS "end" FROM weekly_availability WHERE host_id=$1 ORDER BY weekday,start_min',[id]),
   pool.query(`SELECT to_char(local_date,'YYYY-MM-DD') AS day,is_closed,windows FROM date_overrides WHERE host_id=$1 ORDER BY local_date`,[id])
  ]);
  return {weekly:weekly.rows,overrides:overrides.rows};
 });
 app.put('/api/host/schedule',async(req)=>{
  const id=await requireHost(req);const rows=data(req.body).weekly;
  if(!Array.isArray(rows)||rows.length>84)throw new ApiError(400,'INVALID_SCHEDULE','Expected weekly array (max 84)');
  const byDay=new Map<number,unknown[]>();
  for(const row of rows){const b=data(row);const day=asInt(b.weekday);if(!(day>=0&&day<=6))throw new ApiError(400,'INVALID_SCHEDULE','weekday must be 0-6');byDay.set(day,[...(byDay.get(day)||[]),{start:b.start,end:b.end}]);}
  const valid=[...byDay].flatMap(([weekday,windows])=>validateWindows(windows).map(w=>({...w,weekday})));
  await tx(async db=>{await lockHost(db,id);await db.query('DELETE FROM weekly_availability WHERE host_id=$1',[id]);for(const w of valid)await db.query('INSERT INTO weekly_availability(host_id,weekday,start_min,end_min) VALUES($1,$2,$3,$4)',[id,w.weekday,w.start,w.end]);});
  return {ok:true,count:valid.length};
 });
 app.put('/api/host/overrides/:day',async(req)=>{
  const id=await requireHost(req);const day=param(req,'day');const b=data(req.body);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(`${day}T00:00:00Z`))||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day) throw new ApiError(400,'INVALID_DAY','Use a valid YYYY-MM-DD');
  if(typeof b.is_closed!=='boolean')throw new ApiError(400,'INVALID_OVERRIDE','is_closed must be boolean');
  const windows=validateWindows(b.windows??[]);
  await tx(async db=>{await lockHost(db,id);await db.query(`INSERT INTO date_overrides(host_id,local_date,is_closed,windows) VALUES($1,$2,$3,$4::jsonb)
   ON CONFLICT(host_id,local_date) DO UPDATE SET is_closed=EXCLUDED.is_closed,windows=EXCLUDED.windows`,[id,day,b.is_closed,JSON.stringify(windows)]);});
  return {ok:true};
 });
 app.delete('/api/host/overrides/:day',async(req)=>{
   const host=await requireHost(req),day=param(req,'day');
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(`${day}T00:00:00Z`))||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)
       throw new ApiError(400,'INVALID_DAY','Use a valid YYYY-MM-DD');
   await tx(async db=>{await lockHost(db,host);await db.query('DELETE FROM date_overrides WHERE host_id=$1 AND local_date=$2',[host,day]);});
   return {ok:true};
 });
 app.get('/api/host/bookings',async(req)=>{
  const id=await requireHost(req);
  const r=await pool.query(`SELECT b.id,b.status,b.guest_name,b.guest_email,b.version,b.created_at,b.cancel_reason,s.start_at,s.end_at,e.name AS event_name
    FROM bookings b JOIN booking_sessions s ON s.id=b.session_id JOIN event_types e ON e.id=s.event_type_id
    WHERE s.host_id=$1 AND s.end_at>=clock_timestamp() AND (b.status='confirmed' OR (b.status='held' AND b.hold_expires_at>clock_timestamp())) ORDER BY s.start_at LIMIT 200`,[id]);
  return r.rows;
 });
 app.post('/api/host/bookings/:id/cancel',async(req,reply)=>{
  const hostId=await requireHost(req),b=data(req.body);const reason=sval(b.reason);
  if(reason.length<3 || reason.length>300)throw new ApiError(400,'REASON_REQUIRED','Host cancellation needs a reason');
  const r=await cancelByHost(hostId,uuid(param(req,'id')),reason,reqKey(req.headers['idempotency-key']));reply.code(r.status);return r.payload;
 });
 app.get('/api/hosts/:host/events/:event/slots',async(req)=>{
  const q=data(req.query);const event=await getEvent(pool,param(req,'host'),param(req,'event'));
  const from=sval(q.from),to=sval(q.to)||from,tz=sval(q.tz)||event.time_zone;
  return {host:event.host_name,host_timezone:event.time_zone,event:{id:event.id,name:event.name,slug:event.slug,duration_minutes:event.duration_minutes,capacity:event.capacity,buffer_before_minutes:event.buffer_before_minutes,buffer_after_minutes:event.buffer_after_minutes,minimum_notice_minutes:event.minimum_notice_minutes,booking_horizon_days:event.booking_horizon_days},slots:await generateSlots(pool,event,from,to,tz)};
 });
 app.get('/api/public/hosts',async()=>{
   const r=await pool.query(`SELECT h.slug,h.display_name,h.time_zone,
     count(e.id)::integer AS event_count FROM hosts h
     JOIN event_types e ON e.host_id=h.id AND e.is_active=true
     GROUP BY h.id ORDER BY h.display_name LIMIT 100`);
   return r.rows;
 });
 app.get('/api/public/hosts/:host',async(req)=>{
  const slug=param(req,'host');const host=await one<{id:string;slug:string;display_name:string;time_zone:string}>(pool,'SELECT id,slug,display_name,time_zone FROM hosts WHERE slug=$1',[slug]);
  if(!host)throw new ApiError(404,'HOST_NOT_FOUND','Unknown host');
  const events=await pool.query('SELECT id,name,slug,duration_minutes,capacity,booking_horizon_days,minimum_notice_minutes FROM event_types WHERE host_id=$1 AND is_active=true ORDER BY name',[host.id]);
  return {host,events:events.rows};
 });
 app.post('/api/holds',async(req,reply)=>{
  const result=await hold(req.body,reqKey(req.headers['idempotency-key']));reply.code(result.status);return result.payload;
 });
 app.post('/api/holds/:id/confirm',async(req,reply)=>{
  const token=sval(req.headers['x-booking-token']);
  const result=await confirm(uuid(param(req,'id')),token,req.body,reqKey(req.headers['idempotency-key']));reply.code(result.status);return result.payload;
 });
 app.get('/api/bookings/:token',async(req)=>getManaged(param(req,'token')));
 app.post('/api/bookings/:token/reschedule',async(req,reply)=>{
  const result=await reschedule(param(req,'token'),req.body,reqKey(req.headers['idempotency-key']));reply.code(result.status);return result.payload;
 });
 app.post('/api/bookings/:token/cancel',async(req,reply)=>{
  const result=await cancel(param(req,'token'),sval(data(req.body).reason)||'Cancelled by guest',reqKey(req.headers['idempotency-key']));reply.code(result.status);return result.payload;
 });
 app.get('/api/host/metrics',async(req)=>{
   const host=await requireHost(req);
   const counters=await one<{confirmed:number;held:number;expired:number;cancelled:number}>(pool,`
     SELECT count(*) FILTER(WHERE b.status='confirmed')::int AS confirmed,
       count(*) FILTER(WHERE b.status='held' AND b.hold_expires_at>clock_timestamp())::int AS held,
       count(*) FILTER(WHERE b.status='expired' OR (b.status='held' AND b.hold_expires_at<=clock_timestamp()))::int AS expired,
       count(*) FILTER(WHERE b.status='cancelled')::int AS cancelled
     FROM bookings b JOIN booking_sessions s ON s.id=b.session_id WHERE s.host_id=$1`,[host]);
   const notifications=await one<{count:number}>(pool,`
     SELECT count(*)::int AS count FROM notification_outbox n
     JOIN bookings b ON b.id=n.booking_id JOIN booking_sessions s ON s.id=b.session_id
     WHERE s.host_id=$1`,[host]);
   return {...counters,notification_events:notifications?.count||0};
 });
 app.get('/api/notifications',async(req)=>{
  const id=await requireHost(req);
  const r=await pool.query(`SELECT n.id,n.event_type,n.payload,n.created_at FROM notification_outbox n JOIN bookings b ON b.id=n.booking_id JOIN booking_sessions s ON s.id=b.session_id WHERE s.host_id=$1 ORDER BY n.id DESC LIMIT 100`,[id]);return r.rows;
 });
 // Production: serve the compiled React client. Vite dev server proxies /api.
 app.get('/assets/*',async(req,reply)=>{
  const name=basename(req.url.split('?')[0]);const path=resolve(process.cwd(),'web/dist/assets',name);
  if(!existsSync(path))return reply.code(404).send({error:'NOT_FOUND'});
  const type=extname(name)==='.js'?'text/javascript':extname(name)==='.css'?'text/css':'application/octet-stream';
  return reply.type(type).send(readFileSync(path));
 });
 app.setNotFoundHandler(async(req,reply)=>{
  if(req.url.startsWith('/api/'))return reply.code(404).send({error:'NOT_FOUND'});
  const html=resolve(process.cwd(),'web/dist/index.html');
  if(!existsSync(html))return reply.code(404).send({error:'UI_NOT_BUILT',message:'Run npm run build and refresh'});
  return reply.type('text/html').send(readFileSync(html));
 });
 return app;
}
