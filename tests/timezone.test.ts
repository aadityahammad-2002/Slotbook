import {test} from 'node:test';
import assert from 'node:assert/strict';
import {strictLocalToUTC,parseUtcInstant,localParts,validZone,weekday,utcDayPlus} from '../server/src/time.js';

test('New York spring DST gap and autumn repeated hour are unavailable',()=>{
 assert.equal(strictLocalToUTC('2026-03-08',150,'America/New_York'),null);
 assert.equal(strictLocalToUTC('2026-11-01',90,'America/New_York'),null);
});
test('New York winter and summer local hours resolve to different UTC hours',()=>{
 assert.equal(strictLocalToUTC('2026-12-01',540,'America/New_York')?.toISOString(),'2026-12-01T14:00:00.000Z');
 assert.equal(strictLocalToUTC('2026-07-01',540,'America/New_York')?.toISOString(),'2026-07-01T13:00:00.000Z');
});
test('UTC slot has correct Bengaluru guest display instant',()=>{
 const utc=strictLocalToUTC('2026-12-01',540,'America/New_York');
 assert.ok(utc);
 const india=localParts(utc,'Asia/Kolkata');
 assert.deepEqual([india.h,india.mi],[19,30]);
});
test('Invalid input cannot silently become a booking timestamp',()=>{
 assert.equal(validZone('Not/A_Time_Zone'),false);
 assert.equal(strictLocalToUTC('2026-02-30',540,'UTC'),null);
 assert.throws(()=>parseUtcInstant('2026-11-11T12:00:00'));
 assert.equal(utcDayPlus('2026-10-31',1),'2026-11-01');
 assert.equal(weekday('2026-11-01'),0);
});
