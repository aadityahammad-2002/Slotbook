import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {api, message, operationKey, type RequestError} from './http.js';

type Obj=Record<string,any>;
const tzOptions=['Asia/Kolkata','America/New_York','Europe/London','America/Los_Angeles','Europe/Berlin','Asia/Tokyo','Australia/Sydney','UTC'];
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const minuteFormat=(m:number)=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const json=(value:unknown)=>JSON.stringify(value);
const newKey=operationKey;
const asError=message;
const methodKey=(key:string)=>({'Idempotency-Key':key});
function readTab<T>(key:string,alternative:T):T {
 try{const v=sessionStorage.getItem(key);return v?JSON.parse(v) as T:alternative;}catch{return alternative;}
}
function saveTab(key:string,value:unknown){try{if(value==null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,json(value));}catch{/* session storage optional */}}
function hostDay(timezone:string,daysAhead=0):string {
 try {
  const shifted=new Date();
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(shifted);
  const part=(type:string)=>p.find(x=>x.type===type)?.value||'';
  return dateShift(`${part('year')}-${part('month')}-${part('day')}`,daysAhead);
 }catch{return dateShift(new Date().toISOString().slice(0,10),daysAhead);}
}
function dateShift(day:string,delta:number){const d=new Date(`${day}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
function displayTime(utc:unknown,tz:string):string {
 try{return new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:tz}).format(new Date(String(utc)));}
 catch{return String(utc);}
}
function Message({error,success}:{error?:string;success?:string}) {return error?<p className="message error" role="alert">{error}</p>:success?<p className="message good" role="status">{success}</p>:null;}
function Shell({children,hostSlug,events=[]}:React.PropsWithChildren<{hostSlug?:string;events?:Obj[]}>) {
 const [open,setOpen]=useState(false);
 const links=[{label:'Home',href:'/'},{label:'Browse hosts',href:'/hosts'},
  ...(hostSlug?[{label:'Host events',href:`/${hostSlug}`},...events.slice(0,2).map(e=>({label:e.name,href:`/${hostSlug}/${e.slug}`}))]:[]),
  {label:'Manage booking',href:'/manage'},{label:'Host dashboard',href:'/host'}];
 return <><header className="topbar"><a className="brand" href="/"><span className="brand-mark">S</span> SLOTBOOK</a>
  <button className="mobile-menu" type="button" aria-controls="primary-nav" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'Close menu':'Menu ☰'}</button>
  <nav id="primary-nav" className={open?'nav-open':''} aria-label="Main navigation">{links.map(l=><a key={l.href} href={l.href} className={l.href==='/host'?'nav-pill':''}>{l.label}</a>)}</nav>
 </header><main>{children}</main><footer>Slotbook · Appointment scheduling with PostgreSQL-backed booking guarantees</footer></>;
}
function HostDirectory(){
 const [items,setItems]=useState<Obj[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{api<Obj[]>('/public/hosts').then(setItems).catch(e=>setError(asError(e))).finally(()=>setLoading(false));},[]);
 return <Shell><section className="page-title"><div className="eyebrow">PUBLIC BOOKING</div><h1>Find an appointment.</h1><p>Choose a host and browse their available events.</p></section><Message error={error}/>
  {loading?<p>Loading hosts…</p>:<div className="cards">{items.map(h=><a key={h.slug} className="card" href={`/${h.slug}`}><div className="card-symbol">HOST</div><h2>{h.display_name}</h2><p>{h.time_zone} · {h.event_count} event types</p><span>View events ↗</span></a>)}{!items.length&&<p className="empty">No public hosts are available.</p>}</div>}</Shell>;
}
function Home(){return <Shell><section className="hero"><div className="eyebrow">APPOINTMENT SCHEDULING · POSTGRESQL</div><h1>Make time.<br/><em>Without the double-booking.</em></h1><p>Hosts publish their availability, guests reserve appointments and PostgreSQL keeps each active booking within the host's actual capacity.</p><div className="actions"><a className="button" href="/hosts">Browse available hosts ↗</a><a className="button secondary" href="/host">Host dashboard</a></div><div className="metrics"><div><strong>5 min</strong><span>Temporary hold</span></div><div><strong>UTC</strong><span>Booking instants</span></div><div><strong>PostgreSQL</strong><span>Concurrency authority</span></div></div></section><div className="cards"><a className="card" href="/demo-ny"><div className="card-symbol">01</div><h2>Explore a demo host</h2><p>Interviews and group workshops with host-local working hours.</p><span>View event types ↗</span></a><a className="card" href="/manage"><div className="card-symbol">02</div><h2>Manage your appointment</h2><p>Use a private link to reschedule or cancel a confirmed booking.</p><span>Open management ↗</span></a><a className="card" href="/host"><div className="card-symbol">03</div><h2>Host workspace</h2><p>Manage events, availability, overrides and upcoming bookings.</p><span>Sign in ↗</span></a></div></Shell>}
function HostLanding({slug}:{slug:string}){
 const [info,setInfo]=useState<Obj|null>(null),[error,setError]=useState('');
 useEffect(()=>{api(`/public/hosts/${slug}`).then(setInfo).catch(e=>setError(asError(e)));},[slug]);
 return <Shell hostSlug={slug} events={info?.events||[]}><div className="page-title"><div className="eyebrow">HOST'S PUBLIC EVENTS</div><h1>{info?.host?.display_name||'Appointments'}</h1><p>{info?.host?.time_zone||'Loading available event types…'}</p></div><Message error={error}/><div className="cards">{info?.events?.map((e:Obj)=><a href={`/${slug}/${e.slug}`} className="card" key={e.id}><div className="card-symbol">EVENT</div><h2>{e.name}</h2><p>{e.duration_minutes} minutes · {e.capacity} {e.capacity===1?'seat':'seats'}</p><span>See available times ↗</span></a>)}</div></Shell>;
}
function BookingSlots({host,event,hostTimezone='UTC',horizon=30,disabled=false,onPick,refresh=0}:{host:string;event:string;hostTimezone?:string;horizon?:number;disabled?:boolean;onPick:(slot:Obj)=>void;refresh?:number}){
 const [day,setDay]=useState(()=>hostDay(hostTimezone,1)),[tz,setTz]=useState(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
 const [slots,setSlots]=useState<Obj[]>([]),[info,setInfo]=useState<Obj|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const minimum=hostDay(hostTimezone),effectiveHorizon=Number(info?.event?.booking_horizon_days||horizon),maximum=dateShift(minimum,Math.min(365,Math.max(1,effectiveHorizon)));
 useEffect(()=>{if(day<minimum||day>maximum)setDay(hostDay(hostTimezone,1));},[hostTimezone,horizon,info?.event?.booking_horizon_days]);
 useEffect(()=>{let alive=true;setLoading(true);setError('');
  api(`/hosts/${encodeURIComponent(host)}/events/${encodeURIComponent(event)}/slots?from=${day}&to=${day}&tz=${encodeURIComponent(tz)}`)
   .then(v=>{if(alive){setSlots(Array.isArray(v.slots)?v.slots:[]);setInfo(v);}})
   .catch(e=>{if(alive){setSlots([]);setError(asError(e));}})
   .finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};
 },[day,tz,host,event,refresh]);
 return <div><div className="field-grid"><label>Date (host's local calendar)<input type="date" min={minimum} max={maximum} value={day} onChange={e=>setDay(e.target.value)} disabled={disabled}/></label>
  <label>Display time zone<select value={tz} onChange={e=>setTz(e.target.value)} disabled={disabled}>{!tzOptions.includes(tz)&&<option value={tz}>{tz}</option>}{tzOptions.map(t=><option key={t} value={t}>{t}</option>)}</select></label></div>
  <p className="muted">Host schedule: {hostTimezone}{info?.event?` · ${info.event.duration_minutes} minutes · ${info.event.capacity} ${info.event.capacity===1?'seat':'seats'}`:''}.</p>
  <Message error={error}/>{loading?<p role="status">Loading available times…</p>:slots.length===0?<div className="empty">No open times on this host date. Choose another day.</div>:
   <div className="slot-grid">{slots.map(s=><button key={s.start_at} type="button" disabled={disabled} className="slot" onClick={()=>onPick({...s,display_zone:tz})}><b>{s.guest_local}</b><small>{s.remaining_seats} {s.remaining_seats===1?'seat':'seats'} available</small></button>)}</div>}
 </div>;
}
interface PendingOperation{key:string;body:Obj;path?:string}
function Guest({host,event}:{host:string;event:string}){
 const storeKey=`slotbook-guest:${host}:${event}`;
 const saved=useMemo(()=>readTab<{chosen?:Obj;held?:Obj;pendingHold?:PendingOperation;pendingConfirm?:PendingOperation}>(storeKey,{}),[storeKey]);
 const [meta,setMeta]=useState<Obj|null>(null),[chosen,setChosen]=useState<Obj|null>(saved.chosen||null),[held,setHeld]=useState<Obj|null>(saved.held||null);
 const [pendingHold,setPendingHold]=useState<PendingOperation|null>(saved.pendingHold||null),[pendingConfirm,setPendingConfirm]=useState<PendingOperation|null>(saved.pendingConfirm||null);
 const [name,setName]=useState(String(saved.pendingConfirm?.body.guest_name||'')),[email,setEmail]=useState(String(saved.pendingConfirm?.body.guest_email||''));
 const [result,setResult]=useState<Obj|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[tick,setTick]=useState(0);
 useEffect(()=>{api(`/public/hosts/${host}`).then(setMeta).catch(e=>setError(asError(e)));},[host]);
 useEffect(()=>{saveTab(storeKey,{chosen,held,pendingHold,pendingConfirm});},[storeKey,chosen,held,pendingHold,pendingConfirm]);
 useEffect(()=>{
  if(!held?.hold_token)return;
  let active=true;
  api(`/bookings/${held.hold_token}`).then(current=>{
   if(!active)return;
   if(current.status==='confirmed'){
    setResult({...current,display_zone:chosen?.display_zone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',manage_url:`/manage/${held.hold_token}`});
    saveTab('slotbook-last-manage',`/manage/${held.hold_token}`);setHeld(null);setPendingConfirm(null);
   }else if(current.status==='expired'||current.status==='cancelled'){
    setHeld(null);setChosen(null);setPendingConfirm(null);
    setError('The earlier hold has expired or been released. Please choose a new slot.');setRefresh(x=>x+1);
   }else if(current.status==='held'&&current.server_time){
    setHeld((old:Obj|null)=>old&&old.id===held.id?{...old,server_time:current.server_time,received_mono:performance.now()}:old);
   }
  }).catch(()=>{/* Keep local state for retry after a transient network problem. */});
  return()=>{active=false;};
 },[held?.id]);
 useEffect(()=>{const timer=setInterval(()=>setTick(x=>x+1),1000);return()=>clearInterval(timer);},[]);
 const expiryMs=held ? (held.server_time && typeof held.received_mono==='number'
   ? new Date(held.hold_expires_at).getTime()-new Date(held.server_time).getTime()-(performance.now()-held.received_mono)
   : new Date(held.hold_expires_at).getTime()-Date.now()) : 0;
 const approximateRemaining=Math.max(0,Math.ceil(expiryMs/1000));
 const displayZone=result?.display_zone||chosen?.display_zone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
 async function sendHold(op:PendingOperation){setBusy(true);setError('');try{
  const response=await api('/holds',{method:'POST',headers:methodKey(op.key),body:json(op.body)});
  setHeld({...response,received_mono:performance.now()});setPendingHold(null);setRefresh(x=>x+1);
 }catch(e){setError(`${asError(e)}. If the connection dropped, retry the same request.`);setRefresh(x=>x+1);}finally{setBusy(false);}}
 function createHold(){if(!chosen||held)return;const op=pendingHold||{key:newKey(),body:{event_id:chosen.event_id,start_at:chosen.start_at}};setPendingHold(op);void sendHold(op);}
 async function confirm(){if(!held||!name.trim()||!email.trim())return;
  const body={guest_name:name.trim(),guest_email:email.trim()};
  const op=pendingConfirm&&json(pendingConfirm.body)===json(body)?pendingConfirm:{key:newKey(),body};setPendingConfirm(op);
  setBusy(true);setError('');try{
   const response=await api(`/holds/${held.id}/confirm`,{method:'POST',headers:{...methodKey(op.key),'X-Booking-Token':held.hold_token},body:json(body)});
   setResult({...response,display_zone:displayZone});setHeld(null);setChosen(null);setPendingHold(null);setPendingConfirm(null);
   saveTab('slotbook-last-manage',response.manage_url);setRefresh(x=>x+1);
  }catch(e){setError(asError(e));}finally{setBusy(false);}
 }
 async function releaseHold(){if(!held)return;setBusy(true);setError('');try{
   const response=await api(`/bookings/${held.hold_token}`);
   if(response.status==='held')await api(`/bookings/${held.hold_token}/cancel`,{method:'POST',headers:methodKey(newKey()),body:json({reason:'Guest chose another time'})});
   setHeld(null);setChosen(null);setPendingHold(null);setPendingConfirm(null);setRefresh(x=>x+1);
  }catch(e){setError(asError(e));}finally{setBusy(false);}}
 function selectSlot(s:Obj){setChosen(s);setPendingHold(null);setPendingConfirm(null);setError('');}
 const events=meta?.events||[];
 return <Shell hostSlug={host} events={events}><div className="page-title"><div className="eyebrow">BOOK AN APPOINTMENT · NO LOGIN REQUIRED</div><h1>{events.find((e:Obj)=>e.slug===event)?.name||'Choose an appointment'}</h1><p>Hosted by {meta?.host?.display_name||host}. Select an open time and confirm within the five-minute hold.</p></div>
 <div className="two-cols"><section className="panel"><h2>Available times</h2><BookingSlots host={host} event={event} hostTimezone={meta?.host?.time_zone||'UTC'} horizon={meta?.events?.find((e:Obj)=>e.slug===event)?.booking_horizon_days||30} onPick={selectSlot} refresh={refresh} disabled={Boolean(held||result)}/></section>
 <section className="panel status-panel"><h2>Your reservation</h2>
 {result?<div className="done"><div className="done-icon">✓</div><h3>Appointment confirmed</h3><p>{result.guest_name}, your booking is confirmed.</p><p><strong>{displayTime(result.start_at,displayZone)}</strong> ({displayZone})</p><a className="button" href={result.manage_url}>Manage appointment ↗</a><button className="button secondary wide" onClick={()=>{void navigator.clipboard?.writeText(new URL(result.manage_url,location.origin).href);}}>Copy private management link</button><small>Save this private link for future changes.</small></div>:
 held?<><div className="status-label">TEMPORARY HOLD</div><p>Selected time: <strong>{displayTime(held.start_at,displayZone)}</strong></p><p className="countdown" aria-live="off">{approximateRemaining>0?`About ${Math.floor(approximateRemaining/60)}:${String(approximateRemaining%60).padStart(2,'0')} remaining`:'Hold may have expired — only PostgreSQL decides.'}</p>
 <p className="muted">Countdown is an estimate; the database clock determines expiration.</p><label>Full name<input value={name} onChange={e=>{setName(e.target.value);setPendingConfirm(null);}} placeholder="Your full name" autoComplete="name"/></label><label>Email address<input type="email" value={email} onChange={e=>{setEmail(e.target.value);setPendingConfirm(null);}} placeholder="you@example.com" autoComplete="email"/></label>
 <button className="button wide" onClick={confirm} disabled={busy||name.trim().length<2||!email.includes('@')}>{busy?'Processing…':pendingConfirm?'Retry confirmation safely':'Confirm appointment'}</button><button className="button secondary wide" disabled={busy} onClick={releaseHold}>Release hold / choose another time</button><Message error={error}/></>:
 chosen?<><div className="status-label">SELECTED TIME</div><h3>{displayTime(chosen.start_at,displayZone)}</h3><p className="muted">Host date: {chosen.host_day}. Your display zone: {displayZone}.</p><p>Continue to reserve this seat for five minutes while you enter your details.</p><button className="button wide" onClick={createHold} disabled={busy}>{busy?'Processing…':pendingHold?'Retry previous hold request':'Hold this time for five minutes'}</button><Message error={error}/></>:
 <div className="empty">Choose an available appointment to get started.</div>}
 </section></div></Shell>;
}
function ConfirmDialog({title,children,onCancel,onConfirm,busy=false,confirmLabel='Confirm'}:{title:string;children:React.ReactNode;onCancel:()=>void;onConfirm:()=>void;busy?:boolean;confirmLabel?:string}){
 return <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-label={title} className="dialog-panel"><h2>{title}</h2>{children}<div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Go back</button><button type="button" className="button danger" disabled={busy} onClick={onConfirm}>{busy?'Working…':confirmLabel}</button></div></section></div>;
}
function ManageEntry(){const [token,setToken]=useState('');const last=readTab<string|null>('slotbook-last-manage',null);
 return <Shell><div className="page-title"><div className="eyebrow">PRIVATE BOOKING MANAGEMENT</div><h1>Manage an appointment.</h1><p>Open the private management link you received when confirming your booking.</p></div><section className="panel compact-panel"><label>Private booking token<input value={token} onChange={e=>setToken(e.target.value.trim())} placeholder="Paste your booking token"/></label><a className={`button ${!token?'disabled-link':''}`} href={token?`/manage/${encodeURIComponent(token)}`:'#'}>Open booking</a>{last&&<p><a href={last}>Return to the last confirmed appointment in this tab ↗</a></p>}<p className="muted">There is no public booking search by guest email; this protects private booking details.</p></section></Shell>;
}
function Manage({token}:{token:string}){
 const [booking,setBooking]=useState<Obj|null>(null),[selected,setSelected]=useState<Obj|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[showCancel,setShowCancel]=useState(false),[reason,setReason]=useState('Change of plans');
 const [pending,setPending]=useState<PendingOperation|null>(null);
 async function reload(){try{const v=await api(`/bookings/${token}`);setBooking(v);setError('');}catch(e){setError(asError(e));}}
 useEffect(()=>{void reload();},[token]);
 async function action(kind:'reschedule'|'cancel'){
  if(!booking||busy)return;
  const body=kind==='reschedule'?{start_at:selected?.start_at,expected_version:booking.version}:{reason:reason.trim()||'Cancelled by guest'};
  const matching=pending&&pending.path===kind&&json(pending.body)===json(body);
  const op=matching?pending!:{key:newKey(),body,path:kind};setPending(op);setBusy(true);setError('');
  try{await api(`/bookings/${token}/${kind}`,{method:'POST',headers:methodKey(op.key),body:json(body)});setPending(null);setSelected(null);setShowCancel(false);setRefresh(x=>x+1);await reload();}
  catch(e){setError(asError(e));}finally{setBusy(false);}
 }
 return <Shell hostSlug={booking?.host}><div className="page-title"><div className="eyebrow">PRIVATE LINK · KEEP IT SAFE</div><h1>Your appointment.</h1><p>Changes are saved atomically so a failed reschedule never loses your original booking.</p></div>
 <Message error={error}/><div className="two-cols"><section className="panel">{booking?<><span className="status-label">{booking.status?.toUpperCase()}</span><h2>{booking.event_name}</h2><p><strong>{displayTime(booking.start_at,Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}</strong></p><p className="muted">{booking.guest_name||'Guest details pending'} · {booking.guest_email||''}</p><p className="muted">Version {booking.version}</p><button className="button secondary" type="button" onClick={()=>{void navigator.clipboard?.writeText(location.href);}}>Copy private link</button>{booking.status==='confirmed'&&<button className="button danger wide" onClick={()=>setShowCancel(true)}>Cancel appointment</button>}</>:<p>Loading your appointment…</p>}</section>
 <section className="panel"><h2>Change appointment time</h2>{booking?.status==='confirmed'?<><BookingSlots host={booking.host} event={booking.event} hostTimezone={booking.host_timezone||'UTC'} onPick={s=>{setSelected(s);setPending(null);}} refresh={refresh}/>{selected&&<p>New time: <strong>{selected.guest_local}</strong></p>}<button className="button wide" disabled={!selected||busy} onClick={()=>void action('reschedule')}>{pending?.path==='reschedule'?'Retry reschedule safely':'Move booking to selected time'}</button></>:<div className="empty">Only confirmed bookings can be rescheduled.</div>}</section></div>
 {showCancel&&<ConfirmDialog title="Cancel this appointment?" onCancel={()=>setShowCancel(false)} onConfirm={()=>void action('cancel')} confirmLabel="Cancel booking" busy={busy}><p>This will release the reserved seat for another guest.</p><label>Reason<input value={reason} onChange={e=>{setReason(e.target.value);setPending(null);}}/></label></ConfirmDialog>}
 </Shell>;
}
const starterEvent={name:'',slug:'',duration_minutes:30,capacity:1,buffer_before_minutes:0,buffer_after_minutes:0,minimum_notice_minutes:240,booking_horizon_days:30};
function EventFields({value,onChange,editing=false}:{value:Obj;onChange:(x:Obj)=>void;editing?:boolean}){
 const numberFields:[string,string][]=[['duration_minutes','Duration (minutes)'],['capacity','Capacity (seats)'],['buffer_before_minutes','Buffer before (min)'],['buffer_after_minutes','Buffer after (min)'],['minimum_notice_minutes','Minimum notice (min)'],['booking_horizon_days','Booking horizon (days)']];
 return <><label>Event name<input value={value.name||''} onChange={e=>onChange({...value,name:e.target.value})} required minLength={3}/></label>{!editing&&<label>Public URL slug<input value={value.slug||''} onChange={e=>onChange({...value,slug:e.target.value})} required placeholder="e.g. team-interview"/></label>}
 <div className="field-grid">{numberFields.map(([k,label])=><label key={k}>{label}<input type="number" min={k==='duration_minutes'?15:k==='capacity'||k==='booking_horizon_days'?1:0} max={k==='duration_minutes'?120:k==='capacity'?50:k.startsWith('buffer')?30:k==='booking_horizon_days'?365:43200} value={Number(value[k]??0)} onChange={e=>onChange({...value,[k]:Number(e.target.value)})} required/></label>)}</div></>;
}
function Host(){
 const [me,setMe]=useState<Obj|null|undefined>(undefined),[events,setEvents]=useState<Obj[]>([]),[schedule,setSchedule]=useState<Obj>({weekly:[],overrides:[]}),[bookings,setBookings]=useState<Obj[]>([]),[notifications,setNotifications]=useState<Obj[]>([]),[metrics,setMetrics]=useState<Obj|null>(null);
 const [tab,setTab]=useState('bookings'),[error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false),[password,setPassword]=useState(''),[hostCancelPending,setHostCancelPending]=useState<PendingOperation|null>(null),[email,setEmail]=useState('demo@slotbook.local');
 const [event,setEvent]=useState<Obj>({...starterEvent}),[editing,setEditing]=useState<Obj|null>(null),[zoneEdit,setZoneEdit]=useState(''),[zoneConfirm,setZoneConfirm]=useState(false);
 const [override,setOverride]=useState<Obj>({day:hostDay('America/New_York',1),is_closed:true}),[hours,setHours]=useState('10:00-12:00, 13:00-16:00');
 const [weekday,setWeekday]=useState(1),[start,setStart]=useState('09:00'),[end,setEnd]=useState('17:00'),[confirmCancel,setConfirmCancel]=useState<Obj|null>(null),[cancelReason,setCancelReason]=useState('Schedule conflict');
 async function refresh(){
  let profile:Obj;
  try{profile=await api('/host/me');setMe(profile);}catch(e){const re=e as RequestError;if(re.status===401){setMe(null);setError('');}else{setError(`Unable to check session: ${asError(e)}`);}return;}
  const settled=await Promise.allSettled([api<Obj[]>('/host/events'),api<Obj>('/host/schedule'),api<Obj[]>('/host/bookings'),api<Obj[]>('/notifications'),api<Obj>('/host/metrics')] as const);
  const issues:string[]=[];
  if(settled[0].status==='fulfilled'&&Array.isArray(settled[0].value))setEvents(settled[0].value);else issues.push('events');
  if(settled[1].status==='fulfilled'&&Array.isArray(settled[1].value.weekly)&&Array.isArray(settled[1].value.overrides))setSchedule(settled[1].value);else issues.push('working hours');
  if(settled[2].status==='fulfilled'&&Array.isArray(settled[2].value))setBookings(settled[2].value);else issues.push('bookings');
  if(settled[3].status==='fulfilled'&&Array.isArray(settled[3].value))setNotifications(settled[3].value);else issues.push('notifications');
  if(settled[4].status==='fulfilled')setMetrics(settled[4].value);else issues.push('metrics');
  setError(issues.length?`Signed in, but ${issues.join(', ')} could not load. Refresh to retry.`:'');
 }
 useEffect(()=>{void refresh();},[]);
 async function execute(task:()=>Promise<unknown>,message='Saved successfully.'){
  setBusy(true);setError('');setSuccess('');try{await task();await refresh();setSuccess(message);}catch(e){
    const failure=e as RequestError;
    if(failure.status===401){setMe(null);setError('Your session expired. Please sign in again.');}
    else setError(asError(e));
  }finally{setBusy(false);}
 }
 async function login(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{await api('/auth/login',{method:'POST',body:json({email,password})});setPassword('');await refresh();}catch(e){setError(asError(e));}finally{setBusy(false);}}
 async function logout(){setBusy(true);setError('');try{await api('/auth/logout',{method:'POST'});setMe(null);setPassword('');setEvents([]);setBookings([]);setNotifications([]);setSuccess('Signed out successfully.');}catch(e){setError(asError(e));}finally{setBusy(false);}}
 function parseHours(text:string):Obj[]{return text.split(',').map(piece=>{const m=piece.trim().match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);if(!m)throw new Error('Use HH:MM-HH:MM, separated by commas');const [a,b,c,d]=m.slice(1).map(Number);if(a>23||c>24||b>59||d>59||c===24&&d>0)throw new Error('Invalid time');return {start:a*60+b,end:c*60+d};});}
 async function windows(rows:Obj[]){await execute(()=>api('/host/schedule',{method:'PUT',body:json({weekly:rows})}),'Weekly schedule updated. Existing confirmed appointments are preserved.');}
 async function createEvent(e:React.FormEvent){e.preventDefault();await execute(()=>api('/host/events',{method:'POST',body:json(event)}),'Event type created.');setEvent({...starterEvent});}
 if(me===undefined)return <Shell><section className="panel compact-panel"><h2>Checking host session</h2><Message error={error}/><button className="button secondary" onClick={()=>void refresh()}>Retry connection</button></section></Shell>;
 if(me===null)return <Shell><div className="login-wrap"><section className="panel"><div className="eyebrow">SECURE HOST ACCESS</div><h1>Host sign in.</h1><p className="muted">Sign in to manage events and appointments.</p><form onSubmit={login}><label>Email<input type="email" value={email} autoComplete="username" onChange={e=>setEmail(e.target.value)} required/></label><label>Password<input type="password" value={password} autoComplete="current-password" onChange={e=>setPassword(e.target.value)} required/></label><button className="button wide" disabled={busy}>{busy?'Signing in…':'Sign in'}</button></form><Message error={error} success={success}/><p className="muted">This assignment uses a seeded host account. Local credentials are configured during setup.</p></section></div></Shell>;
 const tabs=['bookings','events','schedule','overrides','notifications','settings'];
 return <Shell hostSlug={me.slug} events={events.filter(e=>e.is_active)}><div className="dashboard-head"><div><div className="eyebrow">HOST WORKSPACE</div><h1>{me.display_name}</h1><p className="muted">{me.time_zone} · {me.email}</p></div><button className="button secondary" disabled={busy} onClick={logout}>Sign out</button></div>
 <nav className="tabs" aria-label="Host workspace tabs">{tabs.map(t=><button key={t} className={tab===t?'active':''} aria-current={tab===t?'page':undefined} onClick={()=>{setTab(t);setError('');setSuccess('');}}>{t}</button>)}<button onClick={()=>void refresh()}>↻ Refresh</button></nav>
 <Message error={error} success={success}/>
 {tab==='bookings'&&<section className="panel"><h2>Upcoming reservations</h2>{metrics&&<div className="stat-grid"><div><strong>{metrics.confirmed}</strong><span>Confirmed</span></div><div><strong>{metrics.held}</strong><span>Active holds</span></div><div><strong>{metrics.expired}</strong><span>Expired</span></div><div><strong>{metrics.notification_events}</strong><span>Events logged</span></div></div>}<p className="muted">All times shown in your host time zone ({me.time_zone}). Expired holds are excluded.</p>{bookings.length===0?<div className="empty">No upcoming active reservations.</div>:<div className="item-list">{bookings.map(b=><div key={b.id} className="list-item"><div><strong>{b.event_name}</strong><p>{displayTime(b.start_at,me.time_zone)} · {b.guest_name||'Guest details pending'} · {b.status}</p></div><button className="button tiny danger" onClick={()=>{setCancelReason('Schedule conflict');setHostCancelPending(null);setConfirmCancel(b);}}>Cancel</button></div>)}</div>}</section>}
 {tab==='events'&&<div className="two-cols"><section className="panel"><h2>Event types</h2>{events.length===0?<div className="empty">Create your first event type.</div>:events.map(e=><div key={e.id} className="list-item"><div><strong>{e.name} {e.is_active?'':'(inactive)'}</strong><p>{e.duration_minutes} minutes · capacity {e.capacity} · buffers {e.buffer_before_minutes}/{e.buffer_after_minutes} min</p><a href={`/${me.slug}/${e.slug}`} target="_blank" rel="noreferrer">Open public booking ↗</a><div className="inline-actions"><button className="button tiny secondary" onClick={()=>setEditing({...e})}>Edit</button><button className="button tiny secondary" disabled={busy} onClick={()=>void execute(()=>api(`/host/events/${e.id}`,{method:'PATCH',body:json({is_active:!e.is_active})}),e.is_active?'Event deactivated; existing bookings remain.':'Event activated.')}>{e.is_active?'Deactivate':'Activate'}</button></div></div></div>)}</section>
  <section className="panel"><h2>{editing?'Edit event type':'Create event type'}</h2><form onSubmit={e=>{e.preventDefault();if(editing)void execute(()=>api(`/host/events/${editing.id}`,{method:'PATCH',body:json({name:editing.name,duration_minutes:editing.duration_minutes,capacity:editing.capacity,buffer_before_minutes:editing.buffer_before_minutes,buffer_after_minutes:editing.buffer_after_minutes,minimum_notice_minutes:editing.minimum_notice_minutes,booking_horizon_days:editing.booking_horizon_days})}),'Event updated.');else void createEvent(e);}}>
   <EventFields editing={Boolean(editing)} value={editing||event} onChange={editing?setEditing:setEvent}/><p className="muted">Scheduling changes are blocked when future active bookings exist. Existing appointments are never silently modified.</p><button className="button wide" disabled={busy}>{editing?'Save event changes':'Create event'}</button>{editing&&<button type="button" className="button secondary wide" onClick={()=>setEditing(null)}>Cancel editing</button>}</form></section></div>}
 {tab==='schedule'&&<div className="two-cols"><section className="panel"><h2>Weekly working hours</h2>{weekdays.map((d,i)=><div className="schedule-row" key={d}><strong>{d}</strong><div>{schedule.weekly.filter((w:Obj)=>w.weekday===i).length===0?'Closed':schedule.weekly.filter((w:Obj)=>w.weekday===i).map((w:Obj,j:number)=><button className="window-chip" title="Remove working-hour window" key={`${i}-${j}`} onClick={()=>void windows(schedule.weekly.filter((a:Obj)=>a!==w))}>{minuteFormat(w.start)}–{minuteFormat(w.end)} ×</button>)}</div></div>)}<button className="button secondary wide" onClick={()=>void windows([])}>Clear weekly hours</button><p className="muted">Changes affect future availability; confirmed bookings are preserved.</p></section>
 <section className="panel"><h2>Add working hours</h2><label>Weekday<select value={weekday} onChange={e=>setWeekday(Number(e.target.value))}>{weekdays.map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label><div className="field-grid"><label>From<input type="time" value={start} onChange={e=>setStart(e.target.value)}/></label><label>To<input type="time" value={end} onChange={e=>setEnd(e.target.value)}/></label></div><button className="button wide" onClick={()=>void windows([...schedule.weekly,{weekday,start:Number(start.slice(0,2))*60+Number(start.slice(3,5)),end:Number(end.slice(0,2))*60+Number(end.slice(3,5))}])}>Add window</button></section></div>}
 {tab==='overrides'&&<div className="two-cols"><section className="panel"><h2>Date overrides</h2>{schedule.overrides.length===0?<p className="empty">No special dates configured.</p>:schedule.overrides.map((o:Obj)=><div className="list-item" key={o.day}><div><strong>{o.day}</strong><p>{o.is_closed?'Closed all day':o.windows.map((w:Obj)=>`${minuteFormat(w.start)}–${minuteFormat(w.end)}`).join(', ')}</p></div><button className="button tiny secondary" onClick={()=>void execute(()=>api(`/host/overrides/${o.day}`,{method:'DELETE'}),'Override removed.')}>Remove</button></div>)}</section>
 <section className="panel"><h2>Override one date</h2><label>Date (host zone)<input type="date" value={override.day} onChange={e=>setOverride({...override,day:e.target.value})}/></label><label>Type<select value={override.is_closed?'closed':'custom'} onChange={e=>setOverride({...override,is_closed:e.target.value==='closed'})}><option value="closed">Day off</option><option value="custom">Custom hours</option></select></label>{!override.is_closed&&<label>Windows (HH:MM-HH:MM, comma-separated)<input value={hours} onChange={e=>setHours(e.target.value)}/></label>}<button className="button wide" disabled={busy} onClick={()=>{try{const ws=override.is_closed?[]:parseHours(hours);void execute(()=>api(`/host/overrides/${override.day}`,{method:'PUT',body:json({is_closed:override.is_closed,windows:ws})}),'Override saved; existing bookings remain.');}catch(e){setError(asError(e));}}}>Save override</button></section></div>}
 {tab==='notifications'&&<section className="panel"><h2>Notification outbox</h2><p className="muted">Confirmed, cancelled and rescheduled booking events are saved transactionally. Real email delivery is not part of this demo.</p>{notifications.length===0?<p className="empty">No notification events yet.</p>:notifications.map(n=><details key={n.id} className="notification-entry"><summary><strong>{n.event_type}</strong> · {displayTime(n.created_at,me.time_zone)}</summary><pre>{JSON.stringify(n.payload,null,2)}</pre></details>)}</section>}
 {tab==='settings'&&<section className="panel compact-panel"><h2>Host time zone</h2><p className="muted">Current: {me.time_zone}. Changing this will affect how future working hours are interpreted, not the UTC time of existing bookings.</p><label>IANA time zone<input list="iana-zones" value={zoneEdit||me.time_zone} onChange={e=>{setZoneEdit(e.target.value);setZoneConfirm(false);}}/><datalist id="iana-zones">{[...new Set([me.time_zone,...tzOptions,...(typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('timeZone'):[])])].map(t=><option value={t} key={t}/>)}</datalist></label><label className="checkline"><input type="checkbox" checked={zoneConfirm} onChange={e=>setZoneConfirm(e.target.checked)}/>I understand existing booking instants will not move.</label><button className="button" disabled={!zoneConfirm||busy} onClick={()=>void execute(()=>api('/host/me',{method:'PATCH',body:json({time_zone:zoneEdit||me.time_zone,acknowledge_existing_bookings:true})}),'Host time zone updated.')}>Update time zone</button></section>}
 {confirmCancel&&<ConfirmDialog title="Cancel this reservation?" onCancel={()=>setConfirmCancel(null)} onConfirm={()=>void execute(async()=>{
 const targetId=confirmCancel.id;
 const body={reason:cancelReason.trim()};
 const previous=hostCancelPending;
 const op:PendingOperation=previous !== null && previous.path===targetId && json(previous.body)===json(body)
  ? previous
  : {key:newKey(),body,path:targetId};
 setHostCancelPending(op);
 await api(`/host/bookings/${targetId}/cancel`,{method:'POST',headers:methodKey(op.key),body:json(body)});
 setHostCancelPending(null);setConfirmCancel(null);
},'Appointment cancelled.')} busy={busy} confirmLabel="Cancel reservation"><p>{confirmCancel.event_name} · {displayTime(confirmCancel.start_at,me.time_zone)}</p><label>Reason (required)<input minLength={3} value={cancelReason} onChange={e=>{setCancelReason(e.target.value);setHostCancelPending(null);}}/></label></ConfirmDialog>}
 </Shell>;
}
function App(){const parts=location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
 if(parts[0]==='host'&&parts.length===1)return <Host/>;
 if(parts[0]==='manage'&&parts[1])return <Manage token={parts[1]}/>;
 if(parts[0]==='manage')return <ManageEntry/>;
 if(parts[0]==='hosts'&&parts.length===1)return <HostDirectory/>;
 if(parts.length===2)return <Guest host={parts[0]} event={parts[1]}/>;
 if(parts.length===1)return <HostLanding slug={parts[0]}/>;
 return <Home/>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
