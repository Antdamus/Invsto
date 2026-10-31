import {definitiveRejection,replyError,validateImage,validId} from './provider.ts';
import {sha256} from '../tiktok-order-sync/tiktok.ts';

export async function prepareReply(body:any,file?:File) {
 if(body.type==='TEXT'){
  if(typeof body.text!=='string'||!body.text.trim()||body.text.trim().length>2000)throw Error('Write a reply between 1 and 2,000 characters.');
  return {type:'TEXT',content:{content:body.text.trim()}};
 }
 if(body.type==='ORDER_CARD'){
  if(!validId(body.orderNumber))throw Error('Choose one of this buyer’s saved orders.');
  return {type:'ORDER_CARD',content:{order_id:body.orderNumber}};
 }
 if(body.type==='IMAGE'){
  if(!file)throw Error('Choose a photo first.');await validateImage(file);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  return {type:'IMAGE',content:{file_hash:hash,file_name:file.name.slice(0,160),file_size:file.size}};
 }
 throw Error('Choose text, a photo or an order card.');
}

// A request ID is permanently tied to one recipient and payload. No provider retry occurs here.
export async function dispatchReply(deps:any,body:any,prepared:any,file?:File) {
 const fingerprint=await sha256(JSON.stringify({type:prepared.type,content:prepared.type==='IMAGE'?prepared.content.file_hash:prepared.content}));
 const claimed=await deps.claim({...prepared,fingerprint,requestId:body.requestId});
 if(!claimed.dispatch)return {attempt:claimed.attempt};
 let attempted=false,content=prepared.content;
 try{
  if(prepared.type==='IMAGE'){content=await deps.upload(file);await deps.saveContent(body.requestId,content);}
  attempted=true;
  const messageId=await deps.send(prepared.type,content);
  try{return {attempt:await deps.finish(body.requestId,'sent',messageId,null)};}
  catch{return {attempt:{...claimed.attempt,status:'sent',content,provider_message_id:messageId,finished_at:new Date().toISOString()},warning:'TikTok accepted this message. Its local receipt could not be saved; do not resend it.'};}
 }catch(e){
  const status=!attempted||definitiveRejection(e)?'failed':'unknown',error=replyError(e);
  try{return {attempt:await deps.finish(body.requestId,status,null,error)};}
  catch{return {attempt:{...claimed.attempt,status,content,error}};}
 }
}
