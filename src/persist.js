import {parse,serialize} from './doc/schema.js';
const KEY = 'corecad.autosave.v1' + (new URLSearchParams(location.search).has('test') ? '.test' : '');
export function restore() { const text=localStorage.getItem(KEY); return text ? parse(text) : null; }
export function autosave(doc) { localStorage.setItem(KEY,serialize(doc)); }
export function download(blob,name) {
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export const projectBlob=doc=>new Blob([serialize(doc)],{type:'application/json'});
export const filename=doc=>doc.meta.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_') || 'Untitled';
export async function readProject(file) { if(file.size>20*1024*1024) throw Error('This project exceeds the 20 MB file limit.');return parse(await file.text()); }
