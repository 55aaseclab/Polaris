const metadata={version:1,appId:'polaris',name:'Polaris',role:'runtime',cards:{supported:false,reason:'runtime'},dataSources:[{id:'observations',label:'Runtime observations',labels:{zh:'运行观察数据'},kind:'json',location:{env:'POLARIS_OBSERVATIONS_FILE'},description:'Workspace-bound read-only runtime observations published outside application source.'}]};
export function describe(){return structuredClone(metadata);}
export async function getCards(){return{status:'unsupported',items:[],reason:'runtime'};}
export async function getDataInventory(context){
 const source=metadata.dataSources[0];
 try{const value=await context.resolveDataSource(structuredClone(source));return{status:'ready',items:[{id:source.id,label:source.label,labels:source.labels,kind:source.kind,...value}]};}
 catch{return{status:'unavailable',items:[{id:source.id,label:source.label,labels:source.labels,kind:source.kind,status:'unavailable',description:'No runtime observation source is registered for this installation.'}]};}
}
