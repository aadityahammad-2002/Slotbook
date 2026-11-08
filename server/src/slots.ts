import type { DB } from './db.js';
import { ApiError, dbNow, one } from './db.js';
import { localDisplay, localParts, strictLocalToUTC, utcDayPlus, validZone, weekday } from './time.js';

export interface HostEvent {
 id:string; host_id:string; host_slug:string; host_name:string; time_zone:string;
 slug:string; name:string; duration_minutes:number; capacity:number;
 buffer_before_minutes:number; buffer_after_minutes:number; minimum_notice_minutes:number;
 booking_horizon_days:number; is_active:boolean;
}
export interface Slot { event_id:string; start_at:string; end_at:string; host_day:string; host_local:string; guest_local:string; remaining_seats:number; capacity:number; }
export async function getEvent(db: DB, hostSlug:string, eventSlug:string):Promise<HostEvent> {
 const r=await one<HostEvent>(db,`SELECT e.*,h.slug AS host_slug,h.display_name AS host_name,h.time_zone
    FROM event_types e JOIN hosts h ON h.id=e.host_id WHERE h.slug=$1 AND e.slug=$2`,[hostSlug,eventSlug]);
 if(!r || !r.is_active) throw new ApiError(404,'EVENT_NOT_FOUND','Event not found');
 return r;
}
export async function getEventById(db:DB,id:string):Promise<HostEvent> {
 const r=await one<HostEvent>(db,`SELECT e.*,h.slug AS host_slug,h.display_name AS host_name,h.time_zone
    FROM event_types e JOIN hosts h ON h.id=e.host_id WHERE e.id=$1`,[id]);
 if(!r || !r.is_active) throw new ApiError(404,'EVENT_NOT_FOUND','Event not found');
 return r;
}
export interface Window { start:number; end:number; }
export function validateWindows(rows: unknown):Window[] {
 if(!Array.isArray(rows) || rows.length>12) throw new ApiError(400,'INVALID_WINDOWS','Expected no more than 12 time windows');
 const windows=rows.map(item=>{
  if(!item || typeof item!=='object') throw new ApiError(400,'INVALID_WINDOWS','Invalid window');
  const v=item as Record<string,unknown>;const start=Number(v.start);const end=Number(v.end);
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>1440||start>=end) throw new ApiError(400,'INVALID_WINDOWS','Use start/end minutes, between 00:00 and 24:00');
  return {start,end};
 }).sort((a,b)=>a.start-b.start);
 for(let i=1;i<windows.length;i++) if(windows[i].start < windows[i-1].end) throw new ApiError(400,'INVALID_WINDOWS','Working-hour windows cannot overlap');
 return windows;
}
export async function generateSlots(db:DB,event:HostEvent, from:string,to:string,guestZone:string):Promise<Slot[]> {
 if(!validZone(guestZone)) throw new ApiError(400,'INVALID_ZONE','Unknown IANA guest time zone');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to) ||
  !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`))) throw new ApiError(400,'INVALID_DATE','Use YYYY-MM-DD');
 const span=(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000;
 if(span<0 || span>30) throw new ApiError(400,'INVALID_DATE_RANGE','Availability query must span 0-30 days');
 const now=await dbNow(db);
 const here=localParts(now,event.time_zone);
 const today=`${here.y}-${String(here.mo).padStart(2,'0')}-${String(here.d).padStart(2,'0')}`;
 const latest=utcDayPlus(today,event.booking_horizon_days);
 const earliestMs=now.getTime()+event.minimum_notice_minutes*60000;
 const maxMs=Date.parse(`${latest}T00:00:00Z`)+86400000;
 const w=await db.query<{weekday:number;start_min:number;end_min:number}>(`SELECT weekday,start_min,end_min FROM weekly_availability WHERE host_id=$1 ORDER BY weekday,start_min`,[event.host_id]);
 const overrides=await db.query<{local_date:string;is_closed:boolean;windows:Window[]}>(`SELECT to_char(local_date,'YYYY-MM-DD') AS local_date,is_closed,windows FROM date_overrides WHERE host_id=$1 AND local_date BETWEEN $2::date AND $3::date`,[event.host_id,from,to]);
 const overrideMap=new Map(overrides.rows.map(r=>[r.local_date,r]));
 const sessions=await db.query<{id:string;event_type_id:string;start_at:Date;end_at:Date;range_start:Date;range_end:Date;capacity:number;used:string}>(`
   SELECT s.id,s.event_type_id,s.start_at,s.end_at,lower(s.occupied_range) AS range_start,upper(s.occupied_range) AS range_end,s.capacity,
    count(b.id) FILTER(WHERE b.status='confirmed' OR (b.status='held' AND b.hold_expires_at>clock_timestamp()))::text AS used
   FROM booking_sessions s LEFT JOIN bookings b ON b.session_id=s.id
   WHERE s.host_id=$1 AND s.state='active' AND s.start_at>=$2::timestamptz AND s.start_at<$3::timestamptz
   GROUP BY s.id`,[event.host_id,new Date(Date.parse(`${from}T00:00:00Z`)-3*86400000).toISOString(),new Date(Date.parse(`${to}T00:00:00Z`)+4*86400000).toISOString()]);
 const slots:Slot[]=[];
 for(let d=0;d<=span;d++) {
  const day=utcDayPlus(from,d);if(day<today || day>latest) continue;
  const over=overrideMap.get(day);
  const windows=over ? (over.is_closed ? [] : validateWindows(over.windows)) : w.rows.filter(x=>x.weekday===weekday(day)).map(x=>({start:x.start_min,end:x.end_min}));
  for(const window of windows) for(let minute=window.start;minute+event.duration_minutes<=window.end;minute+=event.duration_minutes) {
   const start=strictLocalToUTC(day,minute,event.time_zone);
   const end=strictLocalToUTC(day,minute+event.duration_minutes,event.time_zone);
   if(!start || !end || end.getTime()-start.getTime()!==event.duration_minutes*60000) continue;
   const t=start.getTime();if(t<earliestMs || t>=maxMs) continue;
   const before=t-event.buffer_before_minutes*60000, after=end.getTime()+event.buffer_after_minutes*60000;
   let remain=event.capacity;let blocked=false;
   for(const s of sessions.rows) {
    // Expired holds do not consume capacity, even before the background cleanup.
    if(Number(s.used)===0) continue;
    if(before<new Date(s.range_end).getTime() && after>new Date(s.range_start).getTime()) {
      if(s.event_type_id===event.id && new Date(s.start_at).getTime()===t && new Date(s.end_at).getTime()===end.getTime()) {
        remain=Math.min(remain,s.capacity-Number(s.used));
      } else {blocked=true;break;}
    }
   }
   if(blocked || remain<=0) continue;
   slots.push({event_id:event.id,start_at:start.toISOString(),end_at:end.toISOString(),host_day:day,
    host_local:localDisplay(start,event.time_zone),guest_local:localDisplay(start,guestZone),remaining_seats:remain,capacity:event.capacity});
  }
 }
 return slots;
}
