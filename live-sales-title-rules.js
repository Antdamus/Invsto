(() => {
  'use strict';
  const M=window.OGLiveReportModel,$=id=>document.getElementById(id),form=$('title-rules-form');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let current,globalSettings,version=null,signature='',dirty=false,busy=false;
  const status=(text,error=false)=>{$('title-rules-status').textContent=text;$('title-rules-status').classList.toggle('negative',error);};
  const rows=()=>[...form.querySelectorAll('.title-rule')];
  const rules=()=>rows().map(el=>({phrase:el.querySelector('[name="phrase"]').value.trim().replace(/\s+/g,' '),base_cost:M.number(el.querySelector('[name="base_cost"]').value),enabled:el.querySelector('[name="enabled"]').checked}));
  function lock(){
    $('title-rules-fields').disabled=busy||!globalSettings?.can_edit;
    $('reload-title-rules').disabled=busy||!globalSettings;
    $('add-title-rule').disabled=busy||!globalSettings?.can_edit||rows().length>=100;
  }
  function add(rule={phrase:'',base_cost:'',enabled:true}){
    const card=document.createElement('div');card.className='title-rule';
    card.innerHTML=`<div class="title-rule-fields"><label>Title contains<input name="phrase" type="text" minlength="2" maxlength="120" required placeholder="e.g. watch box" value="${esc(rule.phrase)}"></label><label>Total base cost ($)<input name="base_cost" type="number" min="0" max="9999999999.99" step="0.01" required placeholder="Enter cost" value="${esc(rule.base_cost)}"></label></div><div class="title-rule-actions"><label><input name="enabled" type="checkbox" ${rule.enabled?'checked':''}> Enabled</label><button type="button" data-remove-rule>Remove rule</button></div><div class="title-rule-preview"></div>`;
    $('title-rule-list').append(card);
  }
  function preview(){
    const draft=rules(),seen=new Set();let changed=0,conflicts=0;
    rows().forEach(el=>{
      const input=el.querySelector('[name="phrase"]'),key=M.normalizeTitle(input.value);
      input.setCustomValidity(seen.has(key)?'This phrase is already used. Edit the existing rule.':'');seen.add(key);
    });
    const assessed=(current?.rows||[]).map(row=>({row,cost:M.costFor(row,row.override,{...current.settings,titleRules:draft})}));
    for(const {row,cost} of assessed){if(cost.base!==row.cost.base)changed++;if(cost.rule?.conflict)conflicts++;}
    rows().forEach((el,index)=>{
      const rule=draft[index],key=M.normalizeTitle(rule.phrase),matches=key.length>=2?assessed.filter(({row})=>M.normalizeTitle(row.title).includes(key)):[];
      const applied=matches.filter(({cost})=>cost.rule&&!cost.rule.conflict&&cost.rule.index===index).length;
      el.querySelector('.title-rule-preview').innerHTML=!key?'<p>Enter a phrase to preview this show’s matches.</p>':!rule.enabled?'<p>Disabled · this rule will not be used.</p>':`<p><b>${matches.length} matching purchases</b> in this show · ${applied} would use this rule</p>${matches.length?`<ul>${matches.slice(0,3).map(({row,cost})=>`<li><a href="#${esc(row.key)}">Bag #${esc(row.ordinal)} · ${esc(row.title)}</a><small>${cost.rule?.conflict?'Conflicting rules — needs review':row.override.mode&&row.override.mode!=='auto'?'Individual item cost takes priority':cost.rule?.index===index?'Rule base cost: '+M.money(cost.base):'Another matching rule takes priority'}</small></li>`).join('')}</ul>${matches.length>3?`<small>Plus ${matches.length-3} more matching purchases.</small>`:''}`:''}`;
    });
    $('title-rule-empty').hidden=draft.length>0;
    $('title-rule-impact').textContent=current?`${changed} ${changed===1?'purchase':'purchases'} in this show would have a different base cost after saving.${conflicts?' '+conflicts+' have conflicting rules and need review.':''}`:'';
    lock();
  }
  function populate(){
    $('title-rule-list').replaceChildren();for(const rule of globalSettings.title_cost_rules||[])add(rule);
    version=globalSettings.title_rules_updated_at||null;signature=JSON.stringify([globalSettings.title_cost_rules,version]);dirty=false;preview();
    status(globalSettings.can_edit?(version?'Shared rules last saved '+M.date(version):'No shared title rules saved yet.'):'An administrator can edit shared title rules.');
  }
  window.OGLiveTitleRules={update(model,settings){
    current=model;globalSettings=settings;
    if(!globalSettings)return;
    const next=JSON.stringify([settings.title_cost_rules,settings.title_rules_updated_at||null]);
    if(!dirty&&!busy&&next!==signature)populate();else preview();
  }};
  form.addEventListener('input',()=>{dirty=true;status('Unsaved title rules · preview only');preview();});
  $('add-title-rule').onclick=()=>{add();dirty=true;status('Unsaved title rules · preview only');preview();rows().at(-1).querySelector('[name="phrase"]').focus();};
  form.addEventListener('click',event=>{const button=event.target.closest('[data-remove-rule]');if(button){button.closest('.title-rule').remove();dirty=true;status('Rule removed from draft. Save to apply.');preview();}});
  $('reload-title-rules').onclick=()=>{if(globalSettings)populate();};
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!globalSettings?.can_edit)return;
    busy=true;lock();status('Saving shared title rules…');
    try{
      const {data,error}=await window.supabase.rpc('save_title_cost_rules',{_rules:rules(),_expected_updated_at:version});
      if(error)throw error;globalSettings=data;populate();status('Title rules saved globally. Live report totals are updating.');
      document.dispatchEvent(new Event('title-cost-rules-saved'));
    }catch(error){status(error.message,true);}finally{busy=false;lock();}
  };
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
})();
