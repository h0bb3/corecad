import {createDocument} from './doc/model.js';
import {createHistory} from './doc/history.js';
import {createKernel} from './kernel/client.js';
import {restore,autosave} from './persist.js';
export function createStore() {
 const listeners=new Set(),kernel=createKernel();let doc=createDocument(),loadError='';
 try {doc=restore()??doc;}catch(e){loadError='The saved project could not be restored: '+e.message;}
 let history=createHistory(doc),revision=0,preview=null;
 const state={doc,build:null,busy:true,kernelReady:false,error:loadError,saved:false,progress:null};
 const emit=()=>listeners.forEach(fn=>fn(state));
 async function rebuild() {
  const rev=++revision;state.busy=true;state.progress=null;emit();
  try {
   const request=preview??{doc:state.doc,options:{purpose:'commit'}};
   const result=await kernel.rebuild(request.doc,request.options);
   if(rev!==revision||result.status==='superseded')return;
   state.build=result;state.busy=false;state.progress=null;state.error='';emit();
  }catch(e){if(rev===revision){state.error=e.message;state.busy=false;emit();}}
 }
 function save(){try{autosave(state.doc);state.saved=true;}catch(e){state.saved=false;state.error='Autosave failed: '+e.message;}}
 kernel.on('ready',()=>{state.kernelReady=true;emit();});
 kernel.on('error',message=>{state.kernelReady=false;state.busy=false;state.error=message;emit();});
 kernel.on('progress',m=>{state.progress=m;emit();});
 kernel.on('restart',()=>{state.kernelReady=false;state.error='Geometry worker restarted. A stopped operation is skipped until its parameters change or you retry.';rebuild();});
 rebuild();
 return {state,kernel,get history(){return history;},subscribe(fn){listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
  commit(next,label){preview=null;next={...next,meta:{...next.meta,modified:new Date().toISOString()}};state.doc=history.commit(next,label);save();rebuild();},
  undo(){preview=null;state.doc=history.undo();save();rebuild();},redo(){preview=null;state.doc=history.redo();save();rebuild();},
  open(next){preview=null;history=createHistory(next);state.doc=next;state.build=null;state.error='';save();rebuild();},
  preview(next,options={}){preview={doc:next,options:{purpose:'preview',...options}};rebuild();},
  cancelPreview(){preview=null;rebuild();},rebuild,
  clearError(){state.error='';emit();},
 };
}
