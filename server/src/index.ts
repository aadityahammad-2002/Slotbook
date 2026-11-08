import { createApp } from './app.js';
import { migrate, pool } from './db.js';
import { seed } from './seed.js';
import { cleanupAll } from './service.js';
async function main() {
 await migrate();await seed();
 const app=await createApp();
 await app.listen({host:'0.0.0.0',port:Number(process.env.PORT||3000)});
 console.log('Slotbook running. Host dashboard: /host; public booking page: /demo-ny/interview');
 const worker=setInterval(()=>cleanupAll().catch(e=>app.log.error(e)),60_000);worker.unref();
 const stop=async()=>{clearInterval(worker);await app.close();await pool.end();};
 process.on('SIGINT',()=>{stop().then(()=>process.exit(0));});
 process.on('SIGTERM',()=>{stop().then(()=>process.exit(0));});
}
main().catch(async e=>{console.error(e);await pool.end();process.exitCode=1;});
