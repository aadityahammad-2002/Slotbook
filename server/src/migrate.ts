import { migrate, pool } from './db.js';
migrate().then(()=>{console.log('Migrations complete');return pool.end();}).catch(async e=>{console.error(e);await pool.end();process.exitCode=1;});
