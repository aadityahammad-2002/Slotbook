import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { ApiError, one, pool } from './db.js';
import { hashPassword } from './seed.js';
export const digest = (s:string) => createHash('sha256').update(s).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function safeEqual(a:string,b:string) { const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); }
export async function logIn(email:string,password:string) {
 const host=await one<{id:string;password_hash:string;password_salt:string}>(pool,`SELECT id,password_hash,password_salt FROM hosts WHERE email=$1`,[email]);
 if(!host || !safeEqual(host.password_hash,hashPassword(password,host.password_salt))) throw new ApiError(401,'INVALID_LOGIN','Incorrect email or password');
 const token=secret();await pool.query(`INSERT INTO auth_sessions(token_hash,host_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '12 hours')`,[digest(token),host.id]);
 return {token,hostId:host.id};
}
export async function requireHost(req:FastifyRequest):Promise<string> {
 const token=(req.cookies as Record<string,string>|undefined)?.slotbook_session;
 if(!token) throw new ApiError(401,'LOGIN_REQUIRED','Please sign in to the host dashboard');
 const auth=await one<{host_id:string}>(pool,`SELECT host_id FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()`,[digest(token)]);
 if(!auth) throw new ApiError(401,'SESSION_EXPIRED','Please sign in again');
 return auth.host_id;
}
export function verifyBookingToken(raw:string,storedHash:string) {if(!raw || !safeEqual(digest(raw),storedHash)) throw new ApiError(403,'INVALID_TOKEN','Invalid booking management token');}
export async function lockHost(db:DB,hostId:string) { await db.query('SELECT id FROM hosts WHERE id=$1 FOR UPDATE',[hostId]); }
