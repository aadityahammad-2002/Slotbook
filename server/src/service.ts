import { createHash } from 'node:crypto';
import { pool, tx, one, dbNow, ApiError, conflict, type DB } from './db.js';
import { digest, secret, lockHost, verifyBookingToken } from './auth.js';
import { generateSlots, getEventById } from './slots.js';
import { parseUtcInstant } from './time.js';

const active = "('held','confirmed')";
function obj(v:unknown):Record<string,unknown> {if(!v||typeof v!=='object'||Array.isArray(v))throw new ApiError(400,'INVALID_BODY','Expected a JSON object');return v as Record<string,unknown>;}
function string(v:unknown,name:string,min=1,max=200):string {if(typeof v!=='string'||v.trim().length<min||v.length>max)throw new ApiError(400,'INVALID_FIELD',`${name} must contain ${min}-${max} characters`);return v.trim();}
export function requestKey(v:unknown):string {const k=string(v,'Idempotency-Key',8,120);if(!/^[\x21-\x7e]+$/.test(k))throw new ApiError(400,'INVALID_KEY','Idempotency key must be printable ASCII');return k;}
function fingerprint(v:unknown):string {return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
interface IdempotentResult { status:number; payload:Record<string,unknown> }
async function withKey(db:DB,scope:string,key:string,body:unknown,action:()=>Promise<IdempotentResult>):Promise<IdempotentResult> {
 const hash=fingerprint(body);
 const ins=await db.query('INSERT INTO idempotency_records(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',[scope,key,hash]);
 if(!ins.rowCount) {
  const prev=await one<{request_hash:string;http_status:number;response_json:Record<string,unknown>}>(db,'SELECT request_hash,http_status,response_json FROM idempotency_records WHERE scope=$1 AND key=$2',[scope,key]);
  if(!prev || prev.request_hash!==hash) throw new ApiError(409,'IDEMPOTENCY_MISMATCH','This idempotency key was already used with a different request');
  if(!prev.response_json) throw new ApiError(503,'RETRY_LATER','Original request has not completed');
  return {status:prev.http_status,payload:prev.response_json};
 }
 const out=await action();
 await db.query('UPDATE idempotency_records SET http_status=$3,response_json=$4::jsonb WHERE scope=$1 AND key=$2',[scope,key,out.status,JSON.stringify(out.payload)]);
 return out;
}
export async function expireHost(db:DB,hostId:string):Promise<number> {
 const changed=await db.query(`UPDATE bookings b SET status='expired',version=version+1,updated_at=clock_timestamp()
   FROM booking_sessions s WHERE b.session_id=s.id AND s.host_id=$1 AND b.status='held' AND b.hold_expires_at<=clock_timestamp() RETURNING b.id`,[hostId]);
 await db.query(`UPDATE booking_sessions s SET state='released' WHERE s.host_id=$1 AND s.state='active'
   AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.session_id=s.id AND b.status IN ('held','confirmed'))`,[hostId]);
 return changed.rowCount||0;
}
export async function cleanupAll():Promise<number> {
 const hosts=await pool.query<{id:string}>('SELECT id FROM hosts');
 let n=0;
 for(const h of hosts.rows) n+=await tx(async db=>{await lockHost(db,h.id);return expireHost(db,h.id);});
 return n;
}
interface BookingRow {id:string;session_id:string;seat_no:number;token_hash:string;status:string;hold_expires_at:Date;guest_name:string|null;guest_email:string|null;version:number;host_id:string;event_type_id:string;start_at:Date;end_at:Date;event_name:string;host_slug:string;event_slug:string;host_timezone:string;}
async function bookingById(db:DB,id:string):Promise<BookingRow> {
 const b=await one<BookingRow>(db,`SELECT b.*,s.host_id,s.event_type_id,s.start_at,s.end_at,e.name AS event_name,e.slug AS event_slug,h.slug AS host_slug,h.time_zone AS host_timezone
 FROM bookings b JOIN booking_sessions s ON s.id=b.session_id JOIN event_types e ON e.id=s.event_type_id JOIN hosts h ON h.id=s.host_id WHERE b.id=$1`,[id]);
 if(!b) throw new ApiError(404,'BOOKING_NOT_FOUND','Booking not found');return b;
}
function details(b:BookingRow) {return {id:b.id,host:b.host_slug,event:b.event_slug,event_name:b.event_name,host_timezone:b.host_timezone,status:b.status,start_at:new Date(b.start_at).toISOString(),end_at:new Date(b.end_at).toISOString(),hold_expires_at:new Date(b.hold_expires_at).toISOString(),guest_name:b.guest_name,guest_email:b.guest_email,version:b.version};}
export async function getManaged(rawToken:string) {
 const b=await one<BookingRow>(pool,`SELECT b.*,s.host_id,s.event_type_id,s.start_at,s.end_at,e.name AS event_name,e.slug AS event_slug,h.slug AS host_slug,h.time_zone AS host_timezone
 FROM bookings b JOIN booking_sessions s ON s.id=b.session_id JOIN event_types e ON e.id=s.event_type_id JOIN hosts h ON h.id=s.host_id WHERE b.token_hash=$1`,[digest(rawToken)]);
 if(!b) throw new ApiError(404,'BOOKING_NOT_FOUND','Booking not found');
 // Read-time state is authoritative even if scheduled cleanup has not executed yet.
 const now=await dbNow(pool);
 if(b.status==='held' && new Date(b.hold_expires_at).getTime()<=now.getTime()) b.status='expired';
 return {...details(b),server_time:now.toISOString()};
}
async function releaseEmpty(db:DB,sessionId:string) {
 await db.query(`UPDATE booking_sessions s SET state='released' WHERE s.id=$1 AND s.state='active' AND NOT EXISTS
 (SELECT 1 FROM bookings b WHERE b.session_id=s.id AND b.status IN ('held','confirmed'))`,[sessionId]);
}
async function reserveSeat(db:DB,eventId:string,startAt:Date) {
 const event=await getEventById(db,eventId);
 const slots=await generateSlots(db,event,startAt.toISOString().slice(0,10),startAt.toISOString().slice(0,10),event.time_zone);
 // The slot day is host-local, not necessarily the UTC date.
 const local=await db.query<{local_day:string}>(`SELECT to_char($1::timestamptz AT TIME ZONE $2,'YYYY-MM-DD') AS local_day`,[startAt,event.time_zone]);
 const day=local.rows[0].local_day;
 const actualSlots=day===startAt.toISOString().slice(0,10) ? slots : await generateSlots(db,event,day,day,event.time_zone);
 const slot=actualSlots.find(s=>s.start_at===startAt.toISOString());
 if(!slot) conflict('This time is unavailable or outside the host schedule');
 const existing=await one<{id:string}>(db,`SELECT id FROM booking_sessions WHERE event_type_id=$1 AND start_at=$2 AND state='active'`,[event.id,startAt]);
 let sessionId=existing?.id;
 if(!sessionId) {
  const endAt=new Date(startAt.getTime()+event.duration_minutes*60000);
  const ins=await one<{id:string}>(db,`INSERT INTO booking_sessions(host_id,event_type_id,start_at,end_at,duration_minutes,capacity,
    buffer_before_minutes,buffer_after_minutes,occupied_range)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,tstzrange($3::timestamptz - $7::integer*interval '1 minute',$4::timestamptz + $8::integer*interval '1 minute','[)')) RETURNING id`,
   [event.host_id,event.id,startAt,endAt,event.duration_minutes,event.capacity,event.buffer_before_minutes,event.buffer_after_minutes]);
  sessionId=ins!.id;
  await db.query('INSERT INTO session_seats(session_id,seat_no) SELECT $1,generate_series(1,$2)',[sessionId,event.capacity]);
 }
 const seat=await one<{seat_no:number}>(db,`SELECT s.seat_no FROM session_seats s
    WHERE s.session_id=$1 AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.session_id=s.session_id AND b.seat_no=s.seat_no AND b.status IN ('held','confirmed'))
    ORDER BY s.seat_no LIMIT 1`,[sessionId]);
 if(!seat) throw new ApiError(409,'SLOT_FULL','All seats for this session are already booked');
 return {sessionId:sessionId!,seatNo:seat.seat_no,event};
}
export async function hold(input:unknown,key:string):Promise<IdempotentResult> {
 const b=obj(input);const eventId=string(b.event_id,'event_id',36,36);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId))
  throw new ApiError(400,'INVALID_EVENT_ID','event_id must be a UUID');
 let start:Date;try{start=parseUtcInstant(b.start_at);}catch{throw new ApiError(400,'INVALID_TIME','start_at must be an offset-aware ISO timestamp');}
 const event=await getEventById(pool,eventId);
 return tx(async db=>{
  await lockHost(db,event.host_id);await expireHost(db,event.host_id);
  return withKey(db,`hold:${event.host_id}`,key,{eventId,start:start.toISOString()},async()=>{
    const chosen=await reserveSeat(db,eventId,start);
    const token=secret();
    const row=await one<{id:string;hold_expires_at:Date;server_time:Date}>(db,`INSERT INTO bookings(session_id,seat_no,token_hash,status,hold_expires_at)
      VALUES($1,$2,$3,'held',clock_timestamp()+interval '5 minutes') RETURNING id,hold_expires_at,clock_timestamp() AS server_time`,[chosen.sessionId,chosen.seatNo,digest(token)]);
    return {status:201,payload:{id:row!.id,status:'held',hold_token:token,hold_expires_at:new Date(row!.hold_expires_at).toISOString(),server_time:new Date(row!.server_time).toISOString(),start_at:start.toISOString(),event_id:eventId}};
  });
 });
}
export async function confirm(id:string,token:string,input:unknown,key:string):Promise<IdempotentResult> {
 const b=obj(input);const guestName=string(b.guest_name,'guest_name',2,100),email=string(b.guest_email,'guest_email',5,254).toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400,'INVALID_EMAIL','Invalid email');
 return tx(async db=>{
  const before=await bookingById(db,id);verifyBookingToken(token,before.token_hash);
  await lockHost(db,before.host_id);await expireHost(db,before.host_id);
  return withKey(db,`confirm:${id}`,key,{guestName,email,token:digest(token)},async()=>{
   const current=await bookingById(db,id);
   if(current.status!=='held') throw new ApiError(409,'INVALID_STATE','Only an active hold can be confirmed');
   const now=await dbNow(db);
   if(new Date(current.hold_expires_at).getTime()<=now.getTime()) throw new ApiError(409,'HOLD_EXPIRED','The five-minute hold has expired');
   const updated=await one<BookingRow>(db,`UPDATE bookings SET status='confirmed',guest_name=$2,guest_email=$3,version=version+1,updated_at=clock_timestamp()
     WHERE id=$1 RETURNING *`,[id,guestName,email]);
   await emit(db,id,'confirmed',{guest_name:guestName,guest_email:email,start_at:current.start_at});
   return {status:200,payload:{...details({...current,...updated!}),manage_url:`/manage/${token}`}};
  });
 });
}
async function emit(db:DB,id:string,type:string,body:unknown) {
 await db.query('INSERT INTO notification_outbox(booking_id,event_type,payload) VALUES($1,$2,$3::jsonb)',[id,type,JSON.stringify(body)]);
}
export async function cancel(rawToken:string,reason:string,key:string,hostId?:string):Promise<IdempotentResult> {
 const tokenHash=digest(rawToken);
 return tx(async db=>{
  const original=await one<BookingRow>(db,`SELECT b.*,s.host_id,s.event_type_id,s.start_at,s.end_at,e.name AS event_name,e.slug AS event_slug,h.slug AS host_slug,h.time_zone AS host_timezone
    FROM bookings b JOIN booking_sessions s ON s.id=b.session_id JOIN event_types e ON e.id=s.event_type_id JOIN hosts h ON h.id=s.host_id
    WHERE b.token_hash=$1`,[tokenHash]);
  if(!original) throw new ApiError(404,'BOOKING_NOT_FOUND','Booking not found');
  if(hostId && hostId!==original.host_id) throw new ApiError(403,'FORBIDDEN','Not your booking');
  await lockHost(db,original.host_id);await expireHost(db,original.host_id);
  return withKey(db,`cancel:${original.id}`,key,{reason,actor:hostId||tokenHash},async()=>{
    const current=await bookingById(db,original.id);
    if(!['held','confirmed'].includes(current.status)) throw new ApiError(409,'INVALID_STATE','Booking is already inactive');
    const changed=await one<BookingRow>(db,`UPDATE bookings SET status='cancelled',cancel_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[original.id,reason]);
    await releaseEmpty(db,current.session_id);
    await emit(db,original.id,'cancelled',{reason,start_at:current.start_at});
    return {status:200,payload:details({...current,...changed!})};
  });
 });
}
export async function cancelByHost(hostId:string,bookingId:string,reason:string,key:string):Promise<IdempotentResult> {
 const b=await bookingById(pool,bookingId);
 if(b.host_id!==hostId) throw new ApiError(403,'FORBIDDEN','Not your booking');
 // Host is authorized by the session cookie, not by guest token.
 return tx(async db=>{
  await lockHost(db,hostId);await expireHost(db,hostId);
  return withKey(db,`hostcancel:${bookingId}`,key,{reason,hostId},async()=>{
   const current=await bookingById(db,bookingId);
   if(!['held','confirmed'].includes(current.status))throw new ApiError(409,'INVALID_STATE','Booking already inactive');
   const changed=await one<BookingRow>(db,`UPDATE bookings SET status='cancelled',cancel_reason=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[bookingId,reason]);
   await releaseEmpty(db,current.session_id);await emit(db,bookingId,'cancelled',{reason,by:'host'});
   return {status:200,payload:details({...current,...changed!})};
  });
 });
}
export async function reschedule(rawToken:string,input:unknown,key:string):Promise<IdempotentResult> {
 const b=obj(input);const version=Number(b.expected_version);
 if(!Number.isInteger(version)||version<1)throw new ApiError(400,'INVALID_VERSION','expected_version must be positive');
 let start:Date;try{start=parseUtcInstant(b.start_at);}catch{throw new ApiError(400,'INVALID_TIME','start_at must contain a UTC offset');}
 const hash=digest(rawToken);
 return tx(async db=>{
   const original=await one<BookingRow>(db,`SELECT b.*,s.host_id,s.event_type_id,s.start_at,s.end_at,e.name AS event_name,e.slug AS event_slug,h.slug AS host_slug,h.time_zone AS host_timezone
     FROM bookings b JOIN booking_sessions s ON s.id=b.session_id JOIN event_types e ON e.id=s.event_type_id JOIN hosts h ON h.id=s.host_id WHERE b.token_hash=$1`,[hash]);
   if(!original) throw new ApiError(404,'BOOKING_NOT_FOUND','Booking not found');
   await lockHost(db,original.host_id);await expireHost(db,original.host_id);
   return withKey(db,`reschedule:${original.id}`,key,{version,start:start.toISOString(),hash},async()=>{
     const current=await bookingById(db,original.id);
     if(current.status!=='confirmed') throw new ApiError(409,'INVALID_STATE','Only confirmed bookings can be rescheduled');
     if(new Date(current.start_at).getTime() <= (await dbNow(db)).getTime())
       throw new ApiError(409,'APPOINTMENT_STARTED','An appointment that has started cannot be rescheduled');
     if(current.version!==version)throw new ApiError(409,'VERSION_CONFLICT','This booking has changed; refresh before editing');
     if(new Date(current.start_at).getTime()===start.getTime())throw new ApiError(400,'UNCHANGED_TIME','Choose a different appointment time');
     const previousSession=current.session_id;
     // Release before acquiring new range; the deferred consistency guard checks at COMMIT.
     const count=await one<{n:string}>(db,`SELECT count(*)::text AS n FROM bookings WHERE session_id=$1 AND status IN ('held','confirmed')`,[previousSession]);
     if(Number(count!.n)===1) await db.query("UPDATE booking_sessions SET state='released' WHERE id=$1",[previousSession]);
     const seat=await reserveSeat(db,current.event_type_id,start);
     const changed=await one<BookingRow>(db,`UPDATE bookings SET session_id=$2,seat_no=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[current.id,seat.sessionId,seat.seatNo]);
     await releaseEmpty(db,previousSession);
     await emit(db,current.id,'rescheduled',{from:current.start_at,to:start.toISOString()});
     return {status:200,payload:details({...current,...changed!,start_at:start,end_at:new Date(start.getTime()+seat.event.duration_minutes*60000)})};
   });
 });
}
