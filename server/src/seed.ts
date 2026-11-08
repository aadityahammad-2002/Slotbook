import { randomBytes, scryptSync } from 'node:crypto';
import { pool, migrate, tx, one } from './db.js';
export function hashPassword(password: string, salt: string) { return scryptSync(password,salt,64).toString('hex'); }
export async function seed() {
  await tx(async db => {
    const email=process.env.DEMO_EMAIL || 'demo@slotbook.local';
    const password=process.env.DEMO_PASSWORD || 'DemoPass!2026';
    let host=await one<{id:string}>(db,'SELECT id FROM hosts WHERE email=$1',[email]);
    if (!host) {
      const salt=randomBytes(24).toString('hex');
      host=await one<{id:string}>(db,`INSERT INTO hosts(slug,display_name,email,password_salt,password_hash,time_zone)
        VALUES('demo-ny','Demo Host - New York',$1,$2,$3,'America/New_York') RETURNING id`,[email,salt,hashPassword(password,salt)]);
    }
    const id=host!.id;
    const slots=await one<{count:string}>(db,'SELECT count(*) FROM weekly_availability WHERE host_id=$1',[id]);
    if (Number(slots!.count)===0) {
      for (let day=1;day<=5;day++) await db.query('INSERT INTO weekly_availability(host_id,weekday,start_min,end_min) VALUES($1,$2,540,1020)',[id,day]);
    }
    for (const e of [
      {slug:'interview',name:'Interview - 30 minutes',duration:30,cap:1,before:0,after:0},
      {slug:'workshop',name:'Group Workshop - 60 minutes',duration:60,cap:4,before:10,after:10}
    ]) {
      await db.query(`INSERT INTO event_types(host_id,slug,name,duration_minutes,capacity,buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_days)
        VALUES($1,$2,$3,$4,$5,$6,$7,240,30) ON CONFLICT(host_id,slug) DO NOTHING`,
        [id,e.slug,e.name,e.duration,e.cap,e.before,e.after]);
    }
  });
  console.log('Seeded host demo-ny and two event types; existing data unchanged.');
}
if (process.argv[1]?.endsWith('/seed.js')) {
  migrate().then(seed).then(()=>pool.end()).catch(async e=>{console.error(e);await pool.end();process.exitCode=1;});
}
