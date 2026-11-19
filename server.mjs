import {createServer} from 'node:http';
import {constants} from 'node:fs';
import {open, readFile, realpath} from 'node:fs/promises';
import {isAbsolute, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {projectRuntimeTraces} from './praxis-provider.mjs';

const root=fileURLToPath(new URL('.',import.meta.url)).replace(/\/$/,'');
const dist=resolve(root,'apps/polaris-portal/dist');
const id=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const plain=o=>o!==null && typeof o==='object' && !Array.isArray(o);
const baseSetup={completed:false,domainPackId:null,vaultId:null,enabledWorkflowKeys:[],completedAt:null};
const common={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cross-Origin-Resource-Policy':'same-origin'};
function result(res,method,status,body,type='application/json; charset=utf-8',extra={}){
 const bytes=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
 res.writeHead(status,{...common,...extra,'Content-Type':type,'Content-Length':bytes.length});res.end(method==='HEAD'?undefined:bytes);
}
export async function loadObservations(file,workspaceId){
 const blank={workspaceId,packs:[],runs:[],graphs:[],events:{},setup:baseSetup};
 if(!file)return blank;
 if(!isAbsolute(file)||resolve(file)!==file||file===root||file.startsWith(root+sep)||await realpath(file)!==file)throw Error('Invalid observation path.');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=await handle.stat();
  if(!s.isFile()||s.nlink!==1||s.mode&0o077||s.uid!==process.getuid()||s.size>16*1024*1024)throw Error('Invalid observation file.');
  const v=JSON.parse(await handle.readFile('utf8'));
  if(!plain(v)||v.workspaceId!==workspaceId)throw Error('Wrong workspace.');
  for(const key of ['packs','runs','graphs'])if(!Array.isArray(v[key])||v[key].length>20000||!v[key].every(plain))throw Error('Invalid observations.');
  if(!v.packs.every(p=>id.test(p.id)&&Array.isArray(p.flows))||!v.runs.every(r=>id.test(r.id)&&
    typeof r.flowId==='string'&&typeof r.updatedAt==='string'&&Array.isArray(r.steps)&&Array.isArray(r.artifacts))||
    !v.graphs.every(g=>id.test(g.packId)&&id.test(g.flowId)&&plain(g.flow)&&Array.isArray(g.flow.nodes)&&Array.isArray(g.flow.edges)))throw Error('Invalid projections.');
  const events=v.events??{};
  if(!plain(events)||Object.entries(events).some(([k,items])=>!id.test(k)||!Array.isArray(items)||items.some(e=>!plain(e)||!Number.isSafeInteger(e.sequence))))throw Error('Invalid events.');
  const setup=v.setup??baseSetup;
  if(!plain(setup)||typeof setup.completed!=='boolean'||!Array.isArray(setup.enabledWorkflowKeys))throw Error('Invalid workflow setup.');
  const runs=v.runs.map(run=>({...run,artifacts:run.artifacts.map(item=>item.redacted?{...item,content:''}:item)}));
  return {workspaceId,packs:v.packs,runs,graphs:v.graphs,events,setup};
 }finally{await handle.close();}
}
export function observerServer({workspaceId='local',file}={}){
 if(!id.test(workspaceId))throw Error('Invalid workspace.');
 return createServer(async(req,res)=>{
  const method=req.method;
  if(!['GET','HEAD'].includes(method))return result(res,method,405,{error:'Read-only workflow observer.'},undefined,{Allow:'GET, HEAD'});
  const host=req.headers.host||'';
  if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)||!['same-origin','none',undefined].includes(req.headers['sec-fetch-site']))return result(res,method,403,{error:'Forbidden'});
  const prefix=req.headers['x-forwarded-prefix']==='/apps/polaris'?'/apps/polaris':'';
  let url;try{url=new URL(req.url,'http://localhost');}catch{return result(res,method,400,{error:'Invalid URL'});}
  const path=url.pathname;
  if(path==='/health')return result(res,method,200,{ok:true});
  if(path.startsWith('/api/')){
   let s;try{s=await loadObservations(file,workspaceId);}catch{return result(res,method,503,{error:'Workspace observations unavailable'});}
   const answer=value=>result(res,method,200,value),missing=()=>result(res,method,404,{error:'Observation unavailable'});
   if(path==='/api/praxis/traces'){
    if([...url.searchParams.keys()].some(key=>!['before','limit'].includes(key)||url.searchParams.getAll(key).length!==1))return result(res,method,400,{error:'Invalid trace query'});
    const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER,limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):25;
    try{return answer(projectRuntimeTraces(s,{configured:Boolean(file),before,limit}));}catch{return result(res,method,400,{error:'Invalid trace query'});}
   }
   if(path==='/api/workspace')return answer({workspaceId,vaultMode:'host',line:null});
   if(path==='/api/domain-packs')return answer({packs:s.packs});
   if(path==='/api/workflow-setup')return answer(s.setup);
   if(path==='/api/workflow-runs')return answer({runs:s.runs,replayCursor:0});
   if(path==='/api/workflow-vaults')return answer({vaults:[]});
   const graph=/^\/api\/domain-packs\/([^/]+)\/([^/]+)\/graph$/.exec(path);
   if(graph){const g=s.graphs.find(g=>g.packId===graph[1]&&g.flowId===graph[2]);return g?answer({graph:g}):missing();}
   const artifact=/^\/api\/workflow-runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
   if(artifact){
    const run=s.runs.find(r=>r.id===artifact[1]),item=run?.artifacts.find(a=>a.id===artifact[2]);
    if(!item||item.redacted||typeof item.content!=='string')return missing();
    return result(res,method,200,item.content,'text/plain; charset=utf-8',{'Content-Security-Policy':"default-src 'none'; sandbox"});
   }
   const run=/^\/api\/workflow-runs\/([^/]+)(?:\/(events))?$/.exec(path);
   if(run){const item=s.runs.find(r=>r.id===run[1]);if(!item)return missing();if(!run[2])return answer({run:item});
    const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)return result(res,method,400,{error:'Invalid cursor'});
    const events=(Object.hasOwn(s.events,item.id)?s.events[item.id]:[]).filter(e=>e.sequence>after);return answer({runId:item.id,events,nextCursor:events.reduce((n,e)=>Math.max(n,e.sequence),after)});
   }
   return missing();
  }
  const assets={'/shell/shell.js':['shell.js','text/javascript; charset=utf-8'],'/shell/shell.css':['shell.css','text/css; charset=utf-8']};
  try {
   if(Object.hasOwn(assets,path)){const [file,type]=assets[path];return result(res,method,200,await readFile(resolve(dist,file)),type);}
   if(path==='/'||/^\/work(?:\/|$)/.test(path)||/^\/settings(?:\/|$)/.test(path)){
    let html=await readFile(resolve(dist,'index.html'),'utf8');
    if(prefix)html=html.replace('<html','<html data-portal-base="/apps/polaris"').replace(/(["'])\/shell\//g,'$1/apps/polaris/shell/');
    return result(res,method,200,html,'text/html; charset=utf-8');
   }
   return result(res,method,404,{error:'Not found'});
  }catch{return result(res,method,503,{error:'Build the workflow portal before serving it.'});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const port=Number(process.env.PORT||8787),workspaceId=process.env.PRAXIS_WORKSPACE_ID||(process.env.POLARIS_OBSERVATIONS_FILE?'':'local');
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port.');
 observerServer({workspaceId,file:process.env.POLARIS_OBSERVATIONS_FILE}).listen(port,'127.0.0.1');
}
