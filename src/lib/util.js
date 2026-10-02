export const nowIso = () => new Date().toISOString();
export const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID()}`;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const safeJson = (s, fallback = {}) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? fallback); } catch { return fallback; } };
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store, no-cache, must-revalidate', 'pragma':'no-cache', ...headers } });
export const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
export const quantile = (xs, q) => { if (!xs.length) return 0; const a=[...xs].sort((x,y)=>x-y); const p=(a.length-1)*q, lo=Math.floor(p), hi=Math.ceil(p); return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(p-lo); };
export function hashString(str) { let h=2166136261; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
export function mulberry32(seed){ return function(){ let t=seed+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; }; }
export function randn(rng){ let u=0,v=0; while(!u)u=rng(); while(!v)v=rng(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }

export function stableStringify(value){
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(stableStringify).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableStringify(value[k])).join(',')+'}';
}
export async function sha256Hex(value){
  const bytes=new TextEncoder().encode(typeof value==='string'?value:stableStringify(value));
  const out=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(out)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export const APP_VERSION = '0.7.3';
