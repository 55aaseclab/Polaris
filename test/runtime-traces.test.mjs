import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{once}from'node:events';
import{observerServer}from'../server.mjs';import{projectRuntimeTraces,getTraces}from'../praxis-provider.mjs';
const run=(id='run-one')=>({id,flowId:'research-flow',packId:'research-pack',packVersion:'1.2.3',status:'failed',createdAt:'2026-11-18T10:00:00Z',updatedAt:'2026-11-19T10:00:00Z',command:'PRIVATE_COMMAND',input:{token:'PRIVATE_TOKEN'},error:{message:'PRIVATE_ERROR'},steps:[{id:'step-record',stepId:'collect',status:'failed',version:'v2',createdAt:'2026-11-18T10:00:00Z',completedAt:'2026-11-18T10:01:00Z',call:'PRIVATE_CALL',input:{body:'PRIVATE_BODY'},output:{secret:'PRIVATE_OUTPUT'},errorMessage:'PRIVATE_STEP_ERROR'}],artifacts:[{id:'private-report',name:'PRIVATE_FILENAME',content:'PRIVATE_CONTENT',summary:'PRIVATE_SUMMARY'}]});
test('runtime metadata excludes every body, command, error and credential while keeping failed history',()=>{
 const source=run(),value=projectRuntimeTraces({runs:[source]});const serialized=JSON.stringify(value);
 assert.equal(value.runs[0].status,'failed');assert.equal(value.runs[0].runId,'run-one');assert.equal(value.runs[0].nativeHref,'/apps/polaris/work/runs/run-one');assert.equal(value.runs[0].steps[0].stepId,'collect');assert.equal(value.runs[0].steps[0].version,'v2');assert.equal(value.runs[0].packVersion,'1.2.3');
 assert.match(value.runs[0].artifactRefs[0],/^artifact:[a-f0-9]{64}$/);assert.ok(!serialized.includes('PRIVATE_'));assert.ok(!serialized.includes('private-report'));assert.equal(source.steps[0].call,'PRIVATE_CALL');
});
test('finite run pagination covers all observed IDs and describes step truncation honestly',()=>{
 const runs=Array.from({length:90},(_,i)=>({...run('run-'+i),steps:Array.from({length:12},(_,j)=>({stepId:'step-'+j,status:'completed'}))}));let before;const seen=new Set();
 do{const value=projectRuntimeTraces({runs},{...(before&&{before}),limit:25});for(const row of value.runs){seen.add(row.runId);assert.equal(row.stepCount,12);assert.equal(row.steps.length,8);}before=value.nextCursor;}while(before);
 assert.equal(seen.size,90);assert.equal(projectRuntimeTraces({runs:[]}).state,'empty');assert.equal(projectRuntimeTraces({runs:[]},{configured:false}).state,'not_configured');
});
test('provider uses only the declared endpoint and reprojects extra upstream fields',async()=>{
 const page=projectRuntimeTraces({runs:[run()]});page.command='PRIVATE_TOP';page.runs[0].body='PRIVATE_BODY';
 const result=await getTraces({query:{limit:5},readNative:async request=>{assert.deepEqual(request,{path:'/api/praxis/traces',query:{limit:5}});return page;}});
 assert.equal(result.state,'ready');assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal((await getTraces({readNative:async()=>{throw Error('PRIVATE_ERROR')}})).state,'unavailable');
});
test('HTTP metadata is read-only, workspace-bound and distinct from an unconfigured source',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'polaris-trace-metadata-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'observations.json');
 await writeFile(file,JSON.stringify({workspaceId:'synthetic',packs:[],runs:[run()],graphs:[],events:{}}),{mode:0o600});
 const server=observerServer({workspaceId:'synthetic',file});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/praxis/traces?limit=1'),value=await response.json();assert.equal(response.status,200);assert.equal(value.coverage.count,1);assert.ok(!JSON.stringify(value).includes('PRIVATE_'));
 assert.equal((await fetch(base+'/api/praxis/traces',{method:'POST'})).status,405);assert.equal((await fetch(base+'/api/praxis/traces?limit=0')).status,400);assert.equal((await fetch(base+'/api/praxis/traces?body=private')).status,400);
 const blank=observerServer({workspaceId:'synthetic'});blank.listen(0,'127.0.0.1');await once(blank,'listening');t.after(()=>new Promise(resolve=>blank.close(resolve)));assert.equal((await(await fetch('http://127.0.0.1:'+blank.address().port+'/api/praxis/traces')).json()).state,'not_configured');
});
