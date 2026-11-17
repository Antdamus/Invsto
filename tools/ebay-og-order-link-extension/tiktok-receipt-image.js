/* Shared pixel checks. Screen pixels stay local; only the verified video crop is sent. */
(function(){
 'use strict';
 function blank(context,width,height){
  const x=Math.floor(width*.2),y=Math.floor(height*.15),w=Math.max(1,Math.floor(width*.6)),h=Math.max(1,Math.floor(height*.65));
  const pixels=context.getImageData(x,y,w,h).data;let visible=0,total=0;
  for(let i=0;i<pixels.length;i+=Math.max(1,Math.floor(w*h/4096))*4){total++;if(pixels[i+3]>32&&Math.max(pixels[i],pixels[i+1],pixels[i+2])>20)visible++;}
  return visible/total<.01;
 }
 function locate(image,colors,expected){
  const {data,width,height}=image,sets=colors.map(()=>new Set());
  for(let p=0;p<width*height;p++){
   const i=p*4;if(data[i+3]<240)continue;
   for(let c=0;c<colors.length;c++)if(colors[c].every((v,k)=>Math.abs(data[i+k]-v)<5)){sets[c].add(p);break;}
  }
  const squares=sets.map(points=>{
   const found=[];
   while(points.size){
    const first=points.values().next().value,stack=[first];points.delete(first);let x0=width,y0=height,x1=0,y1=0,count=0;
    while(stack.length){const p=stack.pop(),x=p%width,y=Math.floor(p/width);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);count++;
     for(const n of [x>0?p-1:-1,x+1<width?p+1:-1,p-width,p+width])if(points.delete(n))stack.push(n);
    }
    const w=x1-x0+1,h=y1-y0+1;
    if(w>=4&&h>=4&&w<=96&&h<=96&&Math.abs(w/h-1)<.25&&count/(w*h)>.85)found.push({x:x0,y:y0,w,h});
   }
   return found;
  });
  // A unique set of four markers prevents cropping another window or stale frame.
  if(squares.some(s=>s.length!==1))throw Error('Choose the Firefox window showing this receipt, then try again.');
  const [tl,tr,bl,br]=squares.map(s=>s[0]),sx=(tr.x-tl.x)/(expected.width+14),sy=(bl.y-tl.y)/(expected.height+14);
  if(sx<.25||sx>8||Math.abs(sx/sy-1)>.025||Math.abs(tr.y-tl.y)>3||Math.abs(bl.x-tl.x)>3||Math.abs(br.x-tr.x)>3||Math.abs(br.y-bl.y)>3||squares.some(s=>Math.abs(s[0].w-12*sx)>3||Math.abs(s[0].h-12*sy)>3))throw Error('The receipt moved or changed size. Keep it visible and capture again.');
  const rect={x:Math.round(tl.x+12*sx),y:Math.round(tl.y+12*sy),width:Math.round(expected.width*sx),height:Math.round(expected.height*sy)};
  if(rect.x<0||rect.y<0||rect.x+rect.width>width||rect.y+rect.height>height)throw Error('Keep the whole receipt visible.');
  return rect;
 }
 globalThis.ogTikTokReceiptImage=Object.freeze({blank,locate});
})();
