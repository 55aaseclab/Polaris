import { createHash } from 'node:crypto';
const metadata={version:1,appId:'polaris',name:'Polaris',role:'runtime',cards:{supported:false,reason:'runtime'},traces:{supported:true,source:'runtime-observation'},nativeReads:['/api/praxis/traces'],dataSources:[{id:'observations',label:'Runtime observations',labels:{zh:'运行观察数据'},kind:'json',location:{env:'POLARIS_OBSERVATIONS_FILE'},description:'Workspace-bound read-only runtime observations published outside application source.'}]};
export function describe(){return structuredClone(metadata);}
export async function getCards(){return{status:'unsupported',items:[],reason:'runtime'};}
export async function getDataInventory(context){
 const source=metadata.dataSources[0];
 try{const value=await context.resolveDataSource(structuredClone(source));return{status:'ready',items:[{id:source.id,label:source.label,labels:source.labels,kind:source.kind,...value}]};}
 catch{return{status:'unavailable',items:[{id:source.id,label:source.label,labels:source.labels,kind:source.kind,status:'unavailable',description:'No runtime observation source is registered for this installation.'}]};}
}

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)?value:null;
const version=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/.test(value)?value:null;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const states=new Set(['queued','running','waiting','succeeded','failed','cancelled','unknown']);
const stepStates=new Set(['completed','failed','queued','running','waiting','cancelled','unknown']);
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=20000;
const opaque=value=>'artifact:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
function runMetadata(run,projected=false){
 const runId=token(projected?run.runId:run.id);if(!runId)throw Error('Invalid runtime trace.');
 const steps=Array.isArray(run.steps)?run.steps:[],artifacts=Array.isArray(projected?run.artifactRefs:run.artifacts)?projected?run.artifactRefs:run.artifacts:[];
 const visibleSteps=steps.slice(-8).filter(object).map(step=>({
  stepId:token(step.stepId)||token(step.id),status:stepStates.has(step.status)?step.status:'unknown',
  createdAt:instant(step.createdAt),completedAt:instant(step.completedAt),...(version(step.version)?{version:step.version}:{})
 })).filter(step=>step.stepId);
 const artifactRefs=projected?artifacts.filter(value=>typeof value==='string'&&/^artifact:[a-f0-9]{64}$/.test(value)).slice(0,8):artifacts.slice(0,8).filter(value=>object(value)&&token(value.id)).map(value=>opaque([runId,value.id]));
 return {runId,flowId:token(run.flowId),status:states.has(run.status)?run.status:'unknown',createdAt:instant(run.createdAt),updatedAt:instant(run.updatedAt),
  ...(instant(run.startedAt)?{startedAt:instant(run.startedAt)}:{}),...(token(run.packId)?{packId:run.packId}:{}),
  ...(version(run.flowVersion)?{flowVersion:run.flowVersion}:{}),...(version(run.packVersion)?{packVersion:run.packVersion}:{}),
  steps:visibleSteps,stepCount:projected&&count(run.stepCount)?run.stepCount:steps.length,
  artifactRefs,artifactCount:projected&&count(run.artifactCount)?run.artifactCount:artifacts.length};
}
export function projectRuntimeTraces(snapshot,{configured=true,before=Number.MAX_SAFE_INTEGER,limit=25,now=Date.now()}={}){
 if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>50||!Array.isArray(snapshot?.runs))throw Error('Invalid trace query.');
 const runs=snapshot.runs.map(run=>runMetadata(run)).sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)||a.runId.localeCompare(b.runId));
 const candidates=runs.map((run,index)=>({...run,cursor:runs.length-index})).filter(run=>run.cursor<before);
 const page=[];let bytes=0;
 for(const run of candidates.slice(0,limit)){
  const size=Buffer.byteLength(JSON.stringify(run));if(page.length&&bytes+size>80*1024)break;
  page.push(run);bytes+=size;
 }
 const dates=runs.flatMap(run=>[run.createdAt,run.updatedAt].filter(Boolean)).sort();
 return {schemaVersion:1,source:'runtime-observation',state:configured?runs.length?'ready':'empty':'not_configured',generatedAt:new Date(now).toISOString(),
  coverage:{kind:'runtime-observation',count:configured?runs.length:null,firstRecordedAt:dates[0]||null,lastRecordedAt:dates.at(-1)||null},
  runs:configured?page:[],nextCursor:configured&&page.length<candidates.length?page.at(-1)?.cursor||null:null};
}
export async function getTraces(context={}){
 const unavailable=()=>({schemaVersion:1,source:'runtime-observation',state:'unavailable',generatedAt:new Date(context.now??Date.now()).toISOString(),coverage:{kind:'runtime-observation',count:null,firstRecordedAt:null,lastRecordedAt:null},runs:[],nextCursor:null});
 if(typeof context.readNative!=='function')return unavailable();
 try{
  const value=await context.readNative({path:'/api/praxis/traces',query:context.query||{}});
  if(value?.schemaVersion!==1||value.source!=='runtime-observation'||!['ready','empty','not_configured'].includes(value.state)||!Array.isArray(value.runs)||value.runs.length>50||!instant(value.generatedAt)||!object(value.coverage)||value.coverage.kind!=='runtime-observation'||value.coverage.count!==null&&!count(value.coverage.count)||value.nextCursor!==null&&(!Number.isSafeInteger(value.nextCursor)||value.nextCursor<1))return unavailable();
  const runs=value.runs.map(run=>{if(!object(run)||!Number.isSafeInteger(run.cursor)||run.cursor<1)throw Error('Invalid cursor.');return {...runMetadata(run,true),cursor:run.cursor};});
  if(value.state!=='ready'&&runs.length)return unavailable();
  return {schemaVersion:1,source:'runtime-observation',state:value.state,generatedAt:instant(value.generatedAt),coverage:{kind:'runtime-observation',count:value.coverage.count,firstRecordedAt:instant(value.coverage.firstRecordedAt),lastRecordedAt:instant(value.coverage.lastRecordedAt)},runs,nextCursor:value.nextCursor};
 }catch{return unavailable();}
}
