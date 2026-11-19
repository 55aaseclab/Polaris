import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {loadObservations,observerServer} from '../server.mjs';

test('empty startup and private workspace isolation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'polaris-public-observer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'workspace.json'),workspaceId='sample';
 assert.deepEqual((await loadObservations(undefined,workspaceId)).runs,[]);
 await writeFile(file,JSON.stringify({workspaceId,packs:[],runs:[{id:'example-run',flowId:'sample-flow',updatedAt:'2026-01-01T10:00:00Z',steps:[],artifacts:[]}],graphs:[],events:{'example-run':[{sequence:1,title:'Observation imported'}]}}),{mode:0o600});
 const s=observerServer({workspaceId,file});s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(r=>s.close(r)));
 const base='http://127.0.0.1:'+s.address().port;
 assert.equal((await(await fetch(base+'/api/workflow-runs')).json()).runs[0].id,'example-run');
 const events=await(await fetch(base+'/api/workflow-runs/example-run/events?after=0')).json();
 assert.equal(events.nextCursor,1);
 assert.equal((await fetch(base+'/api/workflow-runs',{method:'POST'})).status,405);
 const hostStatus=await new Promise((resolve,reject)=>{
  const req=httpRequest(base+'/api/workflow-runs',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});
  req.once('error',reject);req.end();
 });
 assert.equal(hostStatus,403);
 await assert.rejects(loadObservations(file,'other'));
 await chmod(file,0o644);
 assert.equal((await fetch(base+'/api/workflow-runs')).status,503);
});
