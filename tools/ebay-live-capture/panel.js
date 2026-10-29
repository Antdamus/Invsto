'use strict';
(() => {
  const storageKey='invsto-capture-panel.v1';
  const home=()=>({horizontal:'left',vertical:'bottom',x:12,y:12});
  function mount(box) {
    const style=document.createElement('style');
    style.textContent=`
      #invsto-capture-helper{box-sizing:border-box;display:flex;flex-direction:column;width:366px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);padding:0}
      #invsto-capture-helper [hidden]{display:none!important}
      #invsto-capture-helper .capture-panel-header{display:flex;align-items:center;gap:8px;flex:none;padding:6px 8px;margin-bottom:6px;border-bottom:1px solid #ffffff14}
      #invsto-capture-helper [data-panel-move]{display:flex;align-items:center;gap:7px;flex:1;min-width:0;text-align:left;padding:5px 4px;border:0;background:none;cursor:grab;touch-action:none;user-select:none}
      #invsto-capture-helper [data-panel-move] strong{font-size:12px}
      #invsto-capture-helper [data-panel-capture]{margin-left:auto;font-size:10px;font-weight:400;color:#bfcabe}
      #invsto-capture-helper [data-panel-minimize]{display:grid;place-items:center;width:30px;height:30px;padding:0;flex:none;background:#ffffff08}
      #invsto-capture-helper .capture-panel-content{min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 12px 12px}
      #invsto-capture-helper.capture-panel-minimized{width:340px;border-radius:18px;overflow:hidden}
      #invsto-capture-helper .capture-panel-mini{padding:6px}
      #invsto-capture-helper .capture-panel-mini button{margin:0}
      #invsto-capture-helper .capture-panel-mini-row{display:flex;align-items:stretch;gap:6px}
      #invsto-capture-helper [data-panel-open]{display:flex;align-items:center;justify-content:center;gap:7px;flex:none;width:94px;min-height:46px;padding:0 6px;border:0;background:none;font-weight:700;font-size:12px;touch-action:none;user-select:none;cursor:grab}
      #invsto-capture-helper [data-panel-camera]{display:flex;align-items:center;justify-content:center;gap:10px;flex:1;min-width:0;padding:7px 10px;border:1px solid #f6dfaf80;border-radius:12px;background:linear-gradient(135deg,#f6dfad,#e8c47f);color:#19291f;box-shadow:0 2px 8px #0002;text-align:left}
      #invsto-capture-helper [data-panel-camera]:hover:not(:disabled){background:#f8e3b7}
      #invsto-capture-helper [data-panel-camera] svg{flex:none}
      #invsto-capture-helper [data-panel-camera] span{min-width:0}
      #invsto-capture-helper [data-panel-camera] small{display:block;font-size:9px;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;font-weight:650}
      #invsto-capture-helper [data-panel-camera] strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:1.4;font-weight:750}
      #invsto-capture-helper [data-panel-camera][aria-busy="true"] svg{animation:invsto-photo-pulse 1s ease-in-out infinite alternate}
      #invsto-capture-helper .capture-panel-bag-status{display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;margin:7px 7px 1px;font-size:11px;line-height:1.5}
      #invsto-capture-helper [data-panel-buyer]{flex:1;min-width:45px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d7ded7}
      #invsto-capture-helper [data-panel-print-status]{max-width:100%;padding:3px 7px;border:1px solid #ffffff20;border-radius:7px;background:#ffffff08;color:#c4cfc8;font-size:10px;overflow-wrap:anywhere}
      #invsto-capture-helper [data-panel-print-status][data-state="submitted"]{background:#9ddeaa18;border-color:#9ddeaa50;color:#bce9c6}
      #invsto-capture-helper [data-panel-print-status][data-state="queued"],#invsto-capture-helper [data-panel-print-status][data-state="claimed"],#invsto-capture-helper [data-panel-print-status][data-state="uncertain"]{background:#efd29512;border-color:#efd29550;color:#efd295}
      #invsto-capture-helper [data-panel-print-status][data-state="failed"],#invsto-capture-helper [data-panel-print-status][data-state="cancelled"]{background:#ffb8aa12;border-color:#ffb8aa50;color:#ffb8aa}
      #invsto-capture-helper [data-panel-photo-status]{margin:6px 7px 1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.5;color:#bfccc2}
      #invsto-capture-helper [data-panel-photo-status][data-state="success"]{color:#bce9c6}
      #invsto-capture-helper [data-panel-photo-status][data-state="error"]{color:#ffb8aa}
      @keyframes invsto-photo-pulse{to{opacity:.35}}
      @media(prefers-reduced-motion:reduce){#invsto-capture-helper [data-panel-camera][aria-busy="true"] svg{animation:none}}
      #invsto-capture-helper .capture-panel-dot{width:7px;height:7px;border-radius:50%;background:#a8b3aa;flex:none}
      #invsto-capture-helper[data-panel-state="active"] .capture-panel-dot{background:#9ddeaa;box-shadow:0 0 0 3px #9ddeaa16}
      #invsto-capture-helper[data-panel-state="attention"] .capture-panel-dot,#invsto-capture-helper[data-panel-state="waiting"] .capture-panel-dot{background:#efd295}
      #invsto-capture-helper.capture-panel-dragging [data-panel-move],#invsto-capture-helper.capture-panel-dragging [data-panel-open]{cursor:grabbing}
      #invsto-capture-helper button:focus-visible{outline:2px solid #efd295;outline-offset:2px}
      #invsto-capture-helper .capture-panel-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    `;
    document.head.append(style);
    const content=document.createElement('div');content.className='capture-panel-content';content.id='invsto-capture-panel-content';
    // Keep the existing controls and their in-flight work alive when hidden.
    content.append(...box.childNodes);
    const header=document.createElement('div');header.className='capture-panel-header';
    header.innerHTML='<button type="button" data-panel-move aria-label="Move Invsto panel" title="Drag to move · arrow keys to adjust · Home to reset"><svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><path d="M2 2h2v2H2zm6 0h2v2H8zM2 7h2v2H2zm6 0h2v2H8zM2 12h2v2H2zm6 0h2v2H8z"/></svg><strong>Invsto</strong><span data-panel-capture>Checking capture…</span></button><button type="button" data-panel-minimize aria-label="Minimize Invsto panel" title="Minimize · capture and auto print keep running" aria-controls="invsto-capture-panel-content" aria-expanded="true"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';
    const launcher=document.createElement('button');launcher.type='button';launcher.dataset.panelOpen='';launcher.setAttribute('aria-label','Open Invsto panel');launcher.setAttribute('aria-controls',content.id);launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-describedby','invsto-capture-panel-status');
    launcher.innerHTML='<span class="capture-panel-dot" aria-hidden="true"></span>Invsto<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 7 3-3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const mini=document.createElement('div');mini.className='capture-panel-mini';
    const miniRow=document.createElement('div');miniRow.className='capture-panel-mini-row';
    const camera=document.createElement('button');camera.type='button';camera.dataset.panelCamera='';camera.disabled=true;camera.setAttribute('aria-describedby','invsto-panel-photo-status');
    camera.innerHTML='<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h4a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z"/><circle cx="12" cy="13" r="4"/></svg><span><small>Screenshot</small><strong>Connecting…</strong></span>';
    const photoStatus=document.createElement('p');photoStatus.id='invsto-panel-photo-status';photoStatus.dataset.panelPhotoStatus='';photoStatus.setAttribute('role','status');photoStatus.setAttribute('aria-live','polite');photoStatus.setAttribute('aria-atomic','true');
    const bagStatus=document.createElement('div');bagStatus.className='capture-panel-bag-status';bagStatus.hidden=true;
    const buyer=document.createElement('span');buyer.dataset.panelBuyer='';
    const printStatus=document.createElement('span');printStatus.dataset.panelPrintStatus='';printStatus.setAttribute('role','status');printStatus.setAttribute('aria-live','polite');printStatus.setAttribute('aria-atomic','true');
    bagStatus.append(buyer,printStatus);
    miniRow.append(launcher,camera);mini.append(miniRow,bagStatus,photoStatus);
    const description=document.createElement('span');description.id='invsto-capture-panel-status';description.className='capture-panel-sr';
    box.append(header,content,mini,description);
    const move=header.querySelector('[data-panel-move]'),minimize=header.querySelector('[data-panel-minimize]'),captureLabel=header.querySelector('[data-panel-capture]');
    let position=home(),minimized=false,capture={state:'waiting',label:'Checking capture…'},bag={state:'waiting',label:'Connecting auto print…'};
    try {
      const saved=JSON.parse(localStorage.getItem(storageKey));
      if(saved){
        minimized=saved.minimized===true;
        const p=saved.position;
        if(p&&['left','right'].includes(p.horizontal)&&['top','bottom'].includes(p.vertical)&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0)position=p;
      }
    }catch{}
    const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify({position,minimized}));}catch{}};
    const viewport=()=>({width:document.documentElement.clientWidth,height:window.innerHeight});
    const bounded=(value,available)=>Math.max(8,Math.min(value,available-8));
    function place() {
      if(!box.isConnected)return;
      const rect=box.getBoundingClientRect(),view=viewport();
      box.style.left=box.style.right=box.style.top=box.style.bottom='auto';
      box.style[position.horizontal]=bounded(position.x,view.width-rect.width)+'px';
      box.style[position.vertical]=bounded(position.y,view.height-rect.height)+'px';
    }
    function moveTo(left,top) {
      const rect=box.getBoundingClientRect(),view=viewport();
      const x=bounded(left,view.width-rect.width),y=bounded(top,view.height-rect.height);
      const right=view.width-x-rect.width,bottom=view.height-y-rect.height;
      // Preserve the nearest edges when the panel changes size or is reopened.
      position={horizontal:x<=right?'left':'right',vertical:y<=bottom?'top':'bottom',x:Math.max(8,Math.min(x,right)),y:Math.max(8,Math.min(y,bottom))};
      place();
    }
    function collapse(value,focus=false) {
      minimized=value;box.classList.toggle('capture-panel-minimized',minimized);
      header.hidden=content.hidden=minimized;mini.hidden=!minimized;
      place();
      if(focus)(minimized?launcher:minimize).focus({preventScroll:true});
    }
    minimize.onclick=()=>{collapse(true,true);save();};
    launcher.onclick=()=>{collapse(false,true);save();};
    function draggable(handle) {
      let drag=null,suppressClick=false;
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||!event.isPrimary)return;
        const rect=box.getBoundingClientRect();
        drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false};suppressClick=false;
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove',event=>{
        if(!drag||event.pointerId!==drag.id)return;
        const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
        if(!drag.moved&&Math.hypot(dx,dy)<5)return;
        drag.moved=true;box.classList.add('capture-panel-dragging');event.preventDefault();moveTo(drag.left+dx,drag.top+dy);
      });
      const finish=event=>{
        if(!drag||event.pointerId!==drag.id)return;
        suppressClick=drag.moved;drag=null;box.classList.remove('capture-panel-dragging');
        if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
        if(suppressClick)save();
      };
      for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,finish);
      handle.addEventListener('click',event=>{if(suppressClick&&event.detail!==0){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}},true);
      handle.addEventListener('keydown',event=>{
        const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
        if(event.key==='Home'){event.preventDefault();position=home();place();save();}
        else if(arrows[event.key]){event.preventDefault();const rect=box.getBoundingClientRect(),[dx,dy]=arrows[event.key],step=event.shiftKey?40:10;moveTo(rect.left+dx*step,rect.top+dy*step);save();}
      });
    }
    draggable(move);draggable(launcher);
    const reset=document.createElement('button');reset.type='button';reset.textContent='Reset panel position';reset.onclick=()=>{position=home();place();save();};
    content.querySelector('.bag-settings')?.append(reset);
    function renderStatus() {
      const state=capture.state==='attention'||bag.state==='attention'?'attention':capture.state;
      if(box.dataset.panelState!==state)box.dataset.panelState=state;
      if(captureLabel.textContent!==capture.label)captureLabel.textContent=capture.label;
      const summary=[capture.label,capture.detail,bag.label].filter(Boolean).join(' · ');
      if(description.textContent!==summary)description.textContent=summary;
      launcher.title=summary+' · Click to open or drag to move';
    }
    collapse(minimized);renderStatus();
    requestAnimationFrame(place);new ResizeObserver(place).observe(box);window.addEventListener('resize',place);
    return {
      setCaptureStatus(value){capture=value;renderStatus();},
      setBagStatus(value){bag=value;renderStatus();},
      setPrintStatus(value){
        bagStatus.hidden=!value.buyer;buyer.textContent=value.buyer||'';buyer.title=value.buyer||'';
        printStatus.dataset.state=value.state;printStatus.title=value.detail;
        if(printStatus.textContent!==value.message)printStatus.textContent=value.message;
      },
      setPhotoAction(value){
        camera.disabled=value.disabled;camera.onclick=value.onClick;
        camera.setAttribute('aria-busy',String(value.phase==='saving'));
        camera.setAttribute('aria-label',value.label);camera.title=[value.label,value.buyer].filter(Boolean).join(' · ');
        camera.querySelector('small').textContent=value.phase==='saving'?'Saving…':value.retry?'Retry photo':'Screenshot';
        camera.querySelector('strong').textContent=value.target;
        photoStatus.hidden=!value.message;photoStatus.dataset.state=value.phase;photoStatus.title=value.detail||value.message;
        if(photoStatus.textContent!==value.message)photoStatus.textContent=value.message;
      }
    };
  }
  window.InvstoCapturePanel={mount};
})();
