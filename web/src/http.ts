export type JsonObject=Record<string,any>;
export type RequestError=Error & {status?:number;code?:string};
export function message(e:unknown):string {
 return e instanceof Error ? e.message : 'An unexpected error occurred. Please retry.';
}
export function operationKey():string {return crypto.randomUUID();}
export async function api<T=JsonObject>(path:string, opts:RequestInit={},transport:typeof fetch=fetch):Promise<T>{
 const headers=new Headers(opts.headers);
 // Avoid Fastify's JSON body parser rejecting bodyless POST requests, e.g. logout.
 if(opts.body!==undefined&&opts.body!==null&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
 const response=await transport(`/api${path}`,{...opts,credentials:'same-origin',headers});
 const raw=await response.text();let parsed:any={};
 if(raw){try{parsed=JSON.parse(raw);}catch{
  const error=new Error(`Unexpected server response (HTTP ${response.status})`) as RequestError;
  error.status=response.status;throw error;
 }}
 if(!response.ok){const error=new Error(parsed.message||parsed.error||`HTTP ${response.status}`) as RequestError;
  error.status=response.status;error.code=parsed.error;throw error;}
 return parsed as T;
}
