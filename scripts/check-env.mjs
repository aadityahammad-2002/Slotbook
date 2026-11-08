// Check local and test database targets without logging credentials.
// Run with: node --env-file=.env scripts/check-env.mjs
function parse(name) {
 const raw=process.env[name];
 if(!raw)throw new Error(`${name} is missing from .env`);
 let url;
 try{url=new URL(raw);}catch{throw new Error(`${name} is not a valid URL. URL-encode special password characters (@, #, %, /, :).`);}
 if(!['postgresql:','postgres:'].includes(url.protocol)||!url.hostname||!url.username)
  throw new Error(`${name} must contain a PostgreSQL protocol, host, and username`);
 if(!url.password||url.password==='REPLACE_WITH_REAL_PASSWORD')
  throw new Error(`${name}: set your actual database password in .env`);
 return {name:decodeURIComponent(url.pathname.slice(1)),host:url.hostname,port:url.port||'5432'};
}
try{
 const main=parse('DATABASE_URL'),test=parse('TEST_DATABASE_URL');
 if(main.name!== (process.env.EXPECTED_DATABASE_NAME||'slotbook_ts'))throw new Error(`DATABASE_URL points to ${main.name}, expected slotbook_ts. No database was modified.`);
 if(!test.name.endsWith('_test')||test.name===main.name)throw new Error('TEST_DATABASE_URL must be a separate database ending in _test. No database was modified.');
 console.log(`Environment check OK | Main: ${main.name} (${main.host}:${main.port}) | Test: ${test.name} (${test.host}:${test.port})`);
}catch(e){console.error('Environment check failed:',e instanceof Error?e.message:'Invalid database configuration');process.exitCode=1;}
