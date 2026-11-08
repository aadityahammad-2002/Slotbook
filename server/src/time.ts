// Strict local -> UTC conversion using platform IANA timezone data. Reject DST gaps/folds.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US-u-nu-latn', {
      timeZone: tz, hourCycle: 'h23', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'
    });
    formatters.set(tz,f);
  }
  return f;
}
export function validZone(zone: string): boolean { try { formatter(zone).format(new Date()); return true; } catch { return false; } }
export function localParts(instant: Date, tz: string) {
  const p = Object.fromEntries(formatter(tz).formatToParts(instant).filter(x => x.type !== 'literal').map(x => [x.type,Number(x.value)]));
  return { y:p.year, mo:p.month, d:p.day, h:p.hour, mi:p.minute, s:p.second };
}
function offsetMinutes(t: number, zone: string): number {
  const p = localParts(new Date(t),zone);
  return (Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi,p.s)-Math.floor(t/1000)*1000)/60000;
}
export function strictLocalToUTC(day: string, minuteOfDay: number, zone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || minuteOfDay < 0 || minuteOfDay > 1440) return null;
  const [y,mo,d] = day.split('-').map(Number);
  const midnight = Date.UTC(y,mo-1,d);
  if (new Date(midnight).toISOString().slice(0,10)!==day) return null;
  const localMs = midnight + minuteOfDay*60000;
  const target = new Date(localMs);
  const candidates = new Set<number>();
  const offsets = new Set<number>();
  for (let dh=-48;dh<=48;dh+=6) offsets.add(offsetMinutes(localMs+dh*3600000,zone));
  for (const off of offsets) {
    const cand = localMs-off*60000; const parts = localParts(new Date(cand),zone);
    if (parts.y===target.getUTCFullYear() && parts.mo===target.getUTCMonth()+1 && parts.d===target.getUTCDate() && parts.h===target.getUTCHours() && parts.mi===target.getUTCMinutes()) candidates.add(cand);
  }
  return candidates.size===1 ? new Date([...candidates][0]) : null;
}
export function localDisplay(instant: Date | string, tz: string) {
  return new Intl.DateTimeFormat('en-GB',{timeZone:tz,dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
}
export function utcDayPlus(day: string, n: number): string {
  const d=new Date(`${day}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10);
}
export function weekday(day: string): number { return new Date(`${day}T00:00:00.000Z`).getUTCDay(); }
export function parseUtcInstant(s: unknown): Date {
  if (typeof s !== 'string' || !/T\d\d:\d\d/.test(s) || !/(Z|[+-]\d\d:\d\d)$/.test(s)) throw new Error('Timestamp must include a UTC offset');
  const d=new Date(s); if (!Number.isFinite(d.getTime())) throw new Error('Invalid timestamp'); return d;
}
