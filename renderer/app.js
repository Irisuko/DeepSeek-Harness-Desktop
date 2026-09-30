import { marked } from '../node_modules/marked/lib/marked.esm.js';

const $ = (id) => document.getElementById(id);
const paths = {
  spark:'M12 2c1 5.5 4.5 9 10 10-5.5 1-9 4.5-10 10C11 16.5 7.5 13 2 12 7.5 11 11 7.5 12 2Z M5 3l.5 2L8 6l-2.5.5L5 9l-.5-2.5L2 6l2.5-1Z',
  chat:'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4h2A8.5 8.5 0 0 1 21 11.5Z',
  code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  plus:'M12 5v14M5 12h14',search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',panel:'M8 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',chevron:'m8 10 4 4 4-4',arrowUp:'M12 19V5m-6 6 6-6 6 6',arrowRight:'M5 12h14m-6-6 6 6-6 6',minus:'M5 12h14',square:'M5 5h14v14H5Z',x:'m6 6 12 12M6 18 18 6',play:'m7 4 14 8-14 8V4Z',
  brain:'M12 5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 0 6 4 4 0 0 0 3 4 3 3 0 0 0 6-1V5Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1 0 6 4 4 0 0 1-3 4 3 3 0 0 1-6-1M6 4v3m0 10v3m12-16v3m0 10v3',
  bulb:'M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1.5 1-1 2-1 2H9s.5-1-1-2Z',pen:'m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L5 15l-1 5Z',files:'M8 3h9l4 4v12H8V3Zm9 0v5h4M4 7H2v15h14v-2',terminal:'M8 8l4 4-4 4m6 0h3M3 3h18v18H3Z',shield:'m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6',sliders:'M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m4-6v6M12 14v6m4-6v6',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',settings:'m10 2-1 3-3 1-3-1-1 4 2 2v3l-2 2 2 4 3-1 3 1 1 2h4l1-3 3-1 2-2-1-3V9l1-2-3-3-3 1-1-3h-4ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
};
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.chat}"/></svg>`;}
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const desktop=window.desktop;
const ChatConfig=window.ChatConfig;
let settings={connections:[],modelProfiles:[],model:'',thinking:false,baseUrl:'https://api.deepseek.com',theme:'system',hasApiKey:false,workspace:null};
let sessions=[],currentId=null,mode='chat',attachment=null,engineState='stopped',pendingDelete=null,toastTimer,saveTimer,modelSaving=false;
let harnessUpdateStatus={state:'idle',busy:false,message:'',canCancel:true,prerelease:false};
let harnessUpdatePending=false,harnessUpdateCancelling=false,harnessUpdateEpoch=0;
let refreshingModels=false;
const requests=new Map();
const escapeHTML=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanError=e=>(e.message||String(e)).replace(/^Error invoking remote method '[^']+': Error: /,'');
function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4500);}
function current(){return sessions.find(s=>s.id===currentId);}
function currentRequest(){return [...requests].find(([,r])=>r.sessionId===currentId);}
async function persist(){try{if(desktop)await desktop.saveHistory(sessions);else localStorage.setItem('deepseek-studio-preview',JSON.stringify(sessions));}catch(e){toast(cleanError(e));}}
function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,300);}
function applyTheme(){const dark=settings.theme==='dark'||(settings.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.body.dataset.theme=dark?'dark':'light';}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
function updateModelSelector(){
  const select=$('model-select');
  select.replaceChildren();
  for(const id of ChatConfig.models(settings)) select.add(new Option(ChatConfig.modelLabel(id),id));
  if(settings.connections?.length)select.add(new Option('＋ 添加模型…','__add_model__'));
  if(!select.options.length)select.add(new Option('请先添加平台',''));
  const route=ChatConfig.route(settings);
  $('model-route').textContent=route?ChatConfig.platforms[route.provider].name:'';
  $('edit-model').disabled=!settings.model||modelSaving||refreshingModels;
  $('refresh-models').disabled=!desktop||refreshingModels||modelSaving||!settings.connections?.some(c=>c.provider==='zen');
  $('refresh-models').textContent=refreshingModels?'正在刷新模型…':'刷新 GPT / Claude 模型';
  const capability=ChatConfig.resolve(settings);
  $('think-button').disabled=capability.thinkingMode==='none';
  $('think-button').title=capability.thinkingMode==='none'?'思考由平台默认控制；可在模型配置中指定参数':'调整当前模型的思考参数';
  $('think-button').setAttribute('aria-pressed',String(capability.thinkingMode!=='none'&&settings.thinking));
  select.value=settings.model;
  select.disabled=modelSaving||refreshingModels||!settings.connections?.length;
}
$('model-select').addEventListener('change',async event=>{
  const model=event.target.value;
  if(model==='__add_model__'){updateModelSelector();openModelDialog(true);return;}
  const previous=settings.model;
  if(modelSaving||refreshingModels||model===previous)return;
  settings.model=model;
  modelSaving=true;
  updateModelSelector();
  try{
    if(desktop)await desktop.saveSettings({model});
  }catch(error){
    settings.model=previous;
    toast('模型选择未保存：'+cleanError(error));
  }finally{
    modelSaving=false;
    updateModelSelector();
  }
});
function updateSettingsUI(){applyTheme();updateModelSelector();$('code-workspace').innerHTML=settings.workspace?`${escapeHTML(settings.workspace.split(/[\\/]/).filter(Boolean).pop())}<small>${escapeHTML(settings.workspace)}</small>`:'选择一个项目文件夹<small>代码和项目保留在你的电脑上</small>';}
function updateBounds(){if(!desktop)return;const rect=$('harness-host').getBoundingClientRect();desktop.setHarnessBounds({x:rect.x,y:rect.y,width:rect.width,height:rect.height}).catch(()=>{});desktop.setHarnessVisible(mode==='codex'&&engineState==='running'&&![...document.querySelectorAll('dialog')].some(x=>x.open)).catch(()=>{});}
new ResizeObserver(updateBounds).observe($('main')||document.querySelector('.main'));
new ResizeObserver(updateBounds).observe($('harness-host'));
async function setMode(next){
  if(!['chat','codex'].includes(next))return;
  mode=next;
  const chat=next==='chat';
  $('app').dataset.mode=next;
  document.body.dataset.mode=next;
  $('sidebar').inert=!chat;
  $('sidebar').setAttribute('aria-hidden',String(!chat));
  $('chat-mode').setAttribute('aria-selected',String(chat));
  $('code-mode').setAttribute('aria-selected',String(!chat));
  $('chat-view').classList.toggle('hidden',!chat);
  $('chat-view').inert=!chat;
  $('code-view').classList.toggle('hidden',chat);
  $('code-view').inert=chat;
  if(!chat){
    for(const id of ['search-dialog','confirm-dialog'])if($(id).open)$(id).close();
    pendingDelete=null;
  }
  if(desktop)await desktop.setMode(next);
  updateBounds();
}
function renderHistory(){const list=[...sessions].sort((a,b)=>b.updatedAt-a.updatedAt);$('history-count').textContent=list.length||'';$('history-list').innerHTML=list.length?list.map(s=>`<div class="history-row ${s.id===currentId?'active':''}"><button data-session="${escapeHTML(s.id)}" title="${escapeHTML(s.title)}">${escapeHTML(s.title)}</button><button class="delete" data-delete="${escapeHTML(s.id)}" title="删除对话" aria-label="删除 ${escapeHTML(s.title)}">×</button></div>`).join(''):'<div class="history-empty">你的对话会出现在这里。<br>从一个新问题开始吧。</div>';}
function markdown(content){return DOMPurify.sanitize(marked.parse(content||'',{breaks:true,gfm:true}),{FORBID_TAGS:['img','style','input','form','iframe'],FORBID_ATTR:['style']});}
function renderMessages(scroll=false){const session=current();const messages=session?.messages||[];const empty=messages.length===0;$('welcome').classList.toggle('hidden',!empty);$('suggestions').classList.toggle('hidden',!empty);$('chat-view').classList.toggle('is-empty',empty);$('messages').innerHTML=messages.map((m,index)=>m.role==='user'?`<article class="message user"><div class="user-bubble">${escapeHTML(m.displayContent||m.content)}</div></article>`:`<article class="message assistant"><div class="message-heading">${icon('spark')}DeepSeek</div><div class="message-body">${m.reasoning?`<details class="reasoning"><summary>思考过程</summary><pre>${escapeHTML(m.reasoning)}</pre></details>`:''}${m.content?markdown(m.content):(m.pending?'<div class="message-pending">正在思考…</div>':'')}${m.error?`<div class="message-error">${escapeHTML(m.error)}</div>`:''}${m.cancelled?'<div class="field-help">回复已停止</div>':''}</div>${m.content?`<div class="message-tools"><button data-copy="${index}">复制回复</button></div>`:''}</article>`).join('');const req=currentRequest();$('send-button').innerHTML=icon(req?'square':'arrowUp');$('send-button').classList.toggle('streaming',Boolean(req));$('send-button').setAttribute('aria-label',req?'停止生成':'发送消息');if(scroll)$('conversation-scroll').scrollTop=$('conversation-scroll').scrollHeight;}
function newChat(){if(mode!=='chat')return;currentId=null;attachment=null;$('prompt').value='';renderAttachment();renderHistory();renderMessages();setMode('chat');$('prompt').focus();}
function selectSession(id){if(mode!=='chat')return;currentId=id;attachment=null;$('prompt').value='';renderAttachment();renderHistory();renderMessages(true);setMode('chat');}
async function sendMessage(){if(mode!=='chat')return;const running=currentRequest();if(running){await desktop?.cancelChat(running[0]);return;}const prompt=$('prompt').value.trim();if(!prompt)return;if(!desktop){toast('请在桌面应用中配置 API Key 后发送消息。');openSettings();return;}if(!settings.model||!settings.connections?.length){openSettings();$('settings-error').textContent='请先添加平台和 API Key，保存后再发送。';return;}let session=current();if(!session){if(sessions.length>=500){toast('最多保存 500 个对话，请先导出并删除部分旧对话。');return;}session={id:crypto.randomUUID(),title:prompt.slice(0,28),createdAt:Date.now(),updatedAt:Date.now(),messages:[]};sessions.unshift(session);currentId=session.id;}const fullContent=attachment?`${prompt}\n\n附件 ${attachment.name}：\n\n${attachment.text}`:prompt;session.messages.push({role:'user',content:fullContent,displayContent:attachment?`${prompt}\n📎 ${attachment.name}`:prompt});const apiMessages=session.messages.filter(m=>m.content&&!m.error).map(m=>({role:m.role,content:m.content}));const assistant={role:'assistant',content:'',reasoning:'',pending:true};session.messages.push(assistant);const requestId=crypto.randomUUID();requests.set(requestId,{sessionId:session.id,assistant});session.updatedAt=Date.now();$('prompt').value='';$('prompt').style.height='';attachment=null;renderAttachment();renderHistory();renderMessages(true);queueSave();try{await desktop.chat({requestId,messages:apiMessages,model:settings.model,thinking:settings.thinking});}catch(e){assistant.pending=false;assistant.error=cleanError(e);requests.delete(requestId);renderMessages(true);queueSave();}}
let streamRender=false;
desktop?.onChatEvent(event=>{const req=requests.get(event.requestId);if(!req)return;const message=req.assistant;if(event.type==='delta')message.content+=event.text||'';if(event.type==='reasoning')message.reasoning+=event.text||'';if(event.type==='done'||event.type==='error'){message.pending=false;message.cancelled=event.cancelled||false;if(event.type==='error')message.error=event.text;requests.delete(event.requestId);queueSave();}if(req.sessionId===currentId&&!streamRender){streamRender=true;requestAnimationFrame(()=>{streamRender=false;const el=$('conversation-scroll');const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<120;renderMessages(nearBottom);});}});
function engineStatus(status){engineState=status.state;const names={stopped:'Harness 待启动',starting:'Harness 启动中',running:'Harness 已连接',stopping:'Harness 正在停止',error:'Harness 连接异常'};const label=names[status.state]||'Harness 待启动';$('settings-engine-label').textContent=label;$('engine-bar-label').textContent=status.workspace?`Harness · ${status.workspace.split(/[\\/]/).pop()}`:label;['settings-engine-dot'].forEach(id=>{$(id).className=`status-dot ${status.state==='running'?'active':status.state==='starting'?'starting':status.state==='error'?'error':''}`;});$('code-landing').classList.toggle('hidden',status.state==='running');$('harness-host').classList.toggle('hidden',status.state!=='running');$('engine-bar').classList.toggle('hidden',status.state!=='running');$('start-engine').disabled=harnessUpdateBusy()||['starting','stopping'].includes(status.state);$('start-engine').innerHTML=icon('play')+(status.state==='starting'?'正在启动，首次可能需要几分钟…':status.state==='error'?'重新打开工作区':'打开编程工作区');$('engine-explanation').textContent=status.state==='error'?status.message:status.state==='starting'?'正在加载官方 Harness 插件与本地运行环境，请稍候。':'在桌面设置中添加平台后，Harness 会自动使用共享连接；可在工作区切换模型。';renderHarnessUpdate();updateBounds();}
desktop?.onHarnessStatus(engineStatus);
function harnessUpdateBusy(){return harnessUpdatePending||Boolean(harnessUpdateStatus.busy);}
function engineBlocksUpdate(){return ['running','starting','stopping'].includes(engineState);}
function renderHarnessUpdate(){
  const status=harnessUpdateStatus;
  const busy=harnessUpdateBusy();
  const blocked=engineBlocksUpdate();
  const labels={idle:'可检查官方发布，或直接更新。',checking:'正在检查官方最新发布…',available:'发现可用的官方更新。',current:'当前引擎已是官方最新发布。',downloading:'正在下载官方 Harness…',installing:'正在准备新的引擎…',validating:'正在验证引擎能否正常运行…',cleaning:'更新已完成，正在清理旧引擎…',ready:'引擎已更新，可以打开编程工作区。',error:'更新未完成，请重试。',cancelled:'已取消更新，原有引擎仍可使用。'};
  // Keep technical release identifiers out of this versionless interface.
  const message=String(status.message||labels[status.state]||labels.idle).replace(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g,'对应发布');
  $('harness-update-message').textContent=message;
  $('harness-update-status').dataset.state=status.state;
  $('harness-update-dot').className='status-dot '+(busy?'starting':status.state==='error'?'error':['ready','current'].includes(status.state)?'active':'');
  $('harness-update').setAttribute('aria-busy',String(busy));
  $('harness-update-preview').classList.toggle('hidden',!status.prerelease);
  $('check-harness-update').disabled=!desktop||busy;
  $('update-harness').disabled=!desktop||busy||blocked;
  $('update-harness').title=blocked?'请结束任务并停止引擎后再更新':'';
  $('cancel-harness-update').classList.toggle('hidden',!busy||status.canCancel===false);
  $('cancel-harness-update').disabled=!desktop||harnessUpdateCancelling;
  $('cancel-harness-update').textContent=harnessUpdateCancelling?'正在取消…':'取消更新';
  $('harness-update-running-note').classList.toggle('hidden',!blocked);
  $('harness-update-running-note').textContent=engineState==='stopping'?'正在停止引擎，请稍候再更新。':engineState==='starting'?'请等待引擎启动完成，结束任务并停止引擎后再更新。':'请先结束正在运行的任务，再点击“停止引擎”，然后更新。';
  $('settings-stop-engine').classList.toggle('hidden',engineState!=='running');
  $('start-engine').disabled=busy||['starting','stopping'].includes(engineState);
}
function receiveHarnessUpdateStatus(status){
  if(!status||typeof status.state!=='string')return;
  harnessUpdateEpoch++;
  harnessUpdateStatus={...harnessUpdateStatus,...status};
  renderHarnessUpdate();
}
desktop?.onHarnessUpdateStatus(receiveHarnessUpdateStatus);
async function refreshHarnessUpdateStatus(){
  if(!desktop){renderHarnessUpdate();return;}
  const epoch=harnessUpdateEpoch;
  try{
    const status=await desktop.getHarnessUpdateStatus();
    if(epoch===harnessUpdateEpoch)receiveHarnessUpdateStatus(status);
  }catch(error){
    if(epoch===harnessUpdateEpoch)receiveHarnessUpdateStatus({state:'error',busy:false,message:cleanError(error)});
  }
}
async function runHarnessUpdate(action){
  if(!desktop||harnessUpdateBusy())return;
  if(action!=='check'&&engineBlocksUpdate()){toast('请先结束任务并停止 Harness 引擎。');return;}
  harnessUpdatePending=true;
  renderHarnessUpdate();
  try{
    const method=action==='check'?'checkHarnessUpdate':'updateHarness';
    receiveHarnessUpdateStatus(await desktop[method]());
  }catch(error){
    try{receiveHarnessUpdateStatus(await desktop.getHarnessUpdateStatus());}
    catch{receiveHarnessUpdateStatus({state:'error',busy:false,message:cleanError(error)});}
  }finally{
    harnessUpdatePending=false;
    renderHarnessUpdate();
  }
}
async function cancelHarnessUpdate(){
  if(!desktop||!harnessUpdateBusy()||harnessUpdateCancelling)return;
  harnessUpdateCancelling=true;
  renderHarnessUpdate();
  try{receiveHarnessUpdateStatus(await desktop.cancelHarnessUpdate());}
  catch(error){toast(cleanError(error));}
  finally{harnessUpdateCancelling=false;renderHarnessUpdate();}
}
async function workspace(){if(!desktop){toast('选择本地项目需要使用桌面应用。');return;}const selected=await desktop.chooseWorkspace();if(selected){settings.workspace=selected;updateSettingsUI();setMode('codex');if(engineState==='running')toast('已选择新项目；停止当前引擎后重新打开即可切换。');}}
async function connect(){if(harnessUpdateBusy()){toast('请等待引擎更新完成，或先取消更新。');return;}if(!desktop){toast('请启动桌面应用后打开 Harness 工作区。');return;}if(!settings.workspace){await workspace();if(!settings.workspace)return;}await desktop.connectHarness();}
async function showDialog(id){if(desktop)await desktop.setHarnessVisible(false);$(id).showModal();}
let connectionDraft=[];
function collectConnections(){
  return connectionDraft.map(c=>({...c,baseUrl:document.querySelector('[data-url="'+c.provider+'"]').value.trim(),apiKey:document.querySelector('[data-key="'+c.provider+'"]').value.trim()}));
}
function renderConnections(){
  $('connection-list').innerHTML=connectionDraft.length?connectionDraft.map(c=>`<section class="connection-card"><div class="connection-heading"><strong>${escapeHTML(ChatConfig.platforms[c.provider].name)}</strong><button type="button" class="text-button danger" data-remove-provider="${c.provider}">移除</button></div><label>API Key<input type="password" data-key="${c.provider}" autocomplete="off" ${c.hasApiKey?'':'required'} placeholder="${c.hasApiKey?'已保存 · 留空保持原密钥':'填写此平台的 API Key'}"></label><label>API 地址<input type="url" required data-url="${c.provider}" value="${escapeHTML(c.baseUrl)}"></label></section>`).join(''):'<p class="field-help">尚未添加平台，请在下方添加。</p>';
  for(const c of connectionDraft)document.querySelector('[data-key="'+c.provider+'"]').value=c.apiKey||'';
  $('provider-adds').innerHTML=Object.entries(ChatConfig.platforms).filter(([id])=>!connectionDraft.some(c=>c.provider===id)).map(([id,p])=>`<button type="button" class="secondary-button" data-add-provider="${id}">＋ 添加 ${escapeHTML(p.name)}</button>`).join('');
}
$('provider-adds').addEventListener('click',event=>{
  const id=event.target.closest('[data-add-provider]')?.dataset.addProvider;
  if(!id)return;connectionDraft=collectConnections();
  connectionDraft.push({provider:id,baseUrl:ChatConfig.platforms[id].baseUrl,hasApiKey:false,apiKey:''});renderConnections();
});
$('connection-list').addEventListener('click',event=>{
  const id=event.target.closest('[data-remove-provider]')?.dataset.removeProvider;
  if(!id)return;connectionDraft=collectConnections().filter(c=>c.provider!==id);renderConnections();
});
async function refreshModels(silent=false){
  if(!desktop||refreshingModels||modelSaving||!settings.connections?.some(c=>c.provider==='zen'))return;
  refreshingModels=true;updateModelSelector();
  try{
    const saved=await desktop.refreshModels();
    // Preserve local form state and selections if other settings were saved while the request ran.
    settings.zenCatalog=saved.zenCatalog;
    settings.model=ChatConfig.selectedModel(settings);
    if(!silent)toast(['running','starting'].includes(engineState)?'模型列表已刷新；停止并重启 Harness 后同步。':'模型列表已刷新。');
  }catch(error){if(!silent)toast(cleanError(error));}
  finally{refreshingModels=false;updateModelSelector();}
}
$('refresh-models').addEventListener('click',()=>refreshModels());
function openModelDialog(add=false){
  if(modelSaving||refreshingModels||!settings.connections?.length)return;
  const route=ChatConfig.route(settings);
  const profile=add?null:(settings.modelProfiles||[]).find(p=>p.model===settings.model&&p.provider===route?.provider);
  $('custom-model-id').value=add?'':settings.model;
  $('model-provider').replaceChildren(...settings.connections.map(c=>new Option(ChatConfig.platforms[c.provider].name,c.provider)));
  $('model-provider').value=profile?.provider||ChatConfig.route(settings)?.provider||settings.connections[0].provider;
  $('model-protocol').value=profile?.protocol||'auto';
  $('model-thinking').value=profile?.thinkingMode||'auto';
  syncModelProvider();
  $('model-error').textContent='';showDialog('model-dialog');
}
function syncModelProvider(){
  const model=$('custom-model-id').value.trim();
  const automatic=ChatConfig.isBuiltIn(model,settings);
  $('model-provider').disabled=automatic;
  if(automatic)$('model-provider').value=ChatConfig.route(settings,model)?.provider||'';
}
$('custom-model-id').addEventListener('input',syncModelProvider);
$('edit-model').addEventListener('click',()=>openModelDialog());
$('model-form').addEventListener('submit',async event=>{
  event.preventDefault();if(modelSaving)return;
  const model=$('custom-model-id').value.trim();
  if(!/^[\w./:@+-]{1,128}$/.test(model)){$('model-error').textContent='请填写有效的模型 ID，不要填写显示名称。';return;}
  const profile={model,provider:$('model-provider').value,protocol:$('model-protocol').value,thinkingMode:$('model-thinking').value};
  const expected={deepseek:'chat',responses:'responses',adaptive:'messages',budget:'messages'}[profile.thinkingMode];
  if(expected&&profile.protocol!==expected){$('model-error').textContent='请选择与思考参数匹配的接口类型。';return;}
  const modelProfiles=[...(settings.modelProfiles||[]).filter(p=>p.model!==model),profile];
  modelSaving=true;$('save-model').disabled=true;updateModelSelector();
  try{if(desktop){const saved=await desktop.saveSettings({model,modelProfiles});settings={...settings,...saved};}else settings={...settings,model,modelProfiles};$('model-dialog').close();toast('模型已保存');}
  catch(error){$('model-error').textContent=cleanError(error);}
  finally{modelSaving=false;$('save-model').disabled=false;updateModelSelector();}
});
function openSettings(){connectionDraft=(settings.connections||[]).map(c=>({...c,apiKey:''}));renderConnections();$('theme-select').value=settings.theme;$('settings-error').textContent='';renderHarnessUpdate();refreshHarnessUpdateStatus();showDialog('settings-dialog');}
document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('close',()=>{if(dialog.id==='settings-dialog'){connectionDraft=[];$('connection-list').replaceChildren();}updateBounds();});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});});
let savingConnections=false;
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();if(savingConnections)return;
  const connections=collectConnections().map(c=>({provider:c.provider,baseUrl:c.baseUrl,...(c.apiKey?{apiKey:c.apiKey}:{})}));
  const next={connections,theme:$('theme-select').value};
  savingConnections=true;
  const fields=[...$('settings-form').querySelectorAll('input,select,button')];fields.forEach(el=>el.disabled=true);
  try{
    if(desktop){const saved=await desktop.saveSettings(next);settings={...settings,...saved};}
    else {settings={...settings,theme:next.theme,connections:connections.map(c=>({provider:c.provider,baseUrl:c.baseUrl,hasApiKey:true}))};settings.model=ChatConfig.selectedModel(settings);}
    updateSettingsUI();$('settings-dialog').close();toast(['running','starting'].includes(engineState)?'设置已保存，共享连接将在下次启动 Harness 时生效。':'设置已保存，Chat 与 Harness 共享平台连接。');
  }catch(error){$('settings-error').textContent=cleanError(error);}
  finally{savingConnections=false;fields.forEach(el=>el.disabled=false);updateModelSelector();}
  if(!savingConnections&&!$('settings-dialog').open)void refreshModels(true);
});
function renderSearch(){const query=$('search-input').value.toLowerCase();const found=sessions.filter(s=>`${s.title} ${s.messages.map(m=>m.content).join(' ')}`.toLowerCase().includes(query));$('search-results').innerHTML=found.length?found.map(s=>`<button data-session="${escapeHTML(s.id)}">${escapeHTML(s.title)}<small>${escapeHTML(s.messages.find(m=>m.role==='user')?.displayContent||s.messages.find(m=>m.role==='user')?.content||'')}</small></button>`).join(''):'<div class="search-empty">'+(query?'没有找到相关对话':'还没有对话，试着发起第一个问题吧')+'</div>';}
$('search-input').addEventListener('input',renderSearch);
function renderAttachment(){$('attachment-chip').classList.toggle('hidden',!attachment);$('attachment-chip').innerHTML=attachment?`<span>📎 ${escapeHTML(attachment.name)} · ${(attachment.size/1024).toFixed(1)} KB</span><button data-action="remove-attachment" aria-label="移除附件">×</button>`:'';}
$('file-input').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;if(file.size>128*1024){toast('请添加 128 KB 以内的文本或代码文件。');e.target.value='';return;}const text=await file.text();if(text.includes('\u0000')){toast('暂时仅支持文本和代码文件。');return;}attachment={name:file.name,text,size:file.size};renderAttachment();e.target.value='';});
async function exportHistory(){if(mode!=='chat')return;const content=sessions.map(s=>`# ${s.title}\n\n${s.messages.map(m=>`## ${m.role==='user'?'你':'DeepSeek'}\n\n${m.content}${m.reasoning?'\n\n<details><summary>思考过程</summary>\n\n'+m.reasoning+'\n\n</details>':''}`).join('\n\n')}`).join('\n\n---\n\n');if(desktop){const result=await desktop.exportHistory({content:content||'# DeepSeek\n\n暂无对话。',filename:'DeepSeek-对话-'+new Date().toISOString().slice(0,10)+'.md'});if(result.saved)toast('对话已导出。');return;}const blob=new Blob([content||'# DeepSeek\n\n暂无对话。'],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`DeepSeek-对话-${new Date().toISOString().slice(0,10)}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
const actions={chat:()=>setMode('chat'),codex:()=>setMode('codex'),new:newChat,sidebar:()=>{if(mode!=='chat')return;$('app').classList.toggle('sidebar-collapsed');updateBounds();},settings:openSettings,search:()=>{if(mode!=='chat')return;$('search-input').value='';renderSearch();showDialog('search-dialog');},workspace,connect,disconnect:()=>desktop?.disconnectHarness(),'check-harness-update':()=>runHarnessUpdate('check'),'update-harness':()=>runHarnessUpdate('update'),'cancel-harness-update':cancelHarnessUpdate,send:sendMessage,attach:()=>$('file-input').click(),'remove-attachment':()=>{attachment=null;renderAttachment();},think:async()=>{settings.thinking=!settings.thinking;updateSettingsUI();if(desktop)await desktop.saveSettings({thinking:settings.thinking});},theme:async()=>{settings.theme=document.body.dataset.theme==='dark'?'light':'dark';applyTheme();if(desktop)await desktop.saveSettings({theme:settings.theme});},export:exportHistory};
const chatActions=new Set(['new','search','send','attach','remove-attachment','think','export']);
document.addEventListener('click',async e=>{const el=e.target.closest('button,a');if(!el)return;try{if(el.dataset.close){$(el.dataset.close).close();return;}if(el.dataset.action){if(mode!=='chat'&&chatActions.has(el.dataset.action))return;await actions[el.dataset.action]?.();return;}if(el.dataset.window){if(desktop)await desktop.windowControl(el.dataset.window);return;}if(el.dataset.prompt){$('prompt').value=el.dataset.prompt;$('prompt').focus();return;}if(el.dataset.session){if(mode!=='chat')return;if($('search-dialog').open)$('search-dialog').close();selectSession(el.dataset.session);return;}if(el.dataset.delete){if(mode!=='chat')return;pendingDelete=el.dataset.delete;showDialog('confirm-dialog');return;}if(el.dataset.copy){await navigator.clipboard.writeText(current().messages[Number(el.dataset.copy)].content);toast('回复已复制。');return;}if(el.tagName==='A'){if(el.hasAttribute('download'))return;e.preventDefault();if(desktop)await desktop.openExternal(el.href);else toast('项目地址：https://github.com/deepseek-ai/deepseek-harness');}}catch(error){toast(cleanError(error));}});
$('confirm-delete').addEventListener('click',async()=>{
  if(mode!=='chat'||!pendingDelete)return;
  const deletingId=pendingDelete;
  for(const [id,r]of requests)if(r.sessionId===deletingId){await desktop?.cancelChat(id);requests.delete(id);}
  sessions=sessions.filter(s=>s.id!==deletingId);
  if(currentId===deletingId)currentId=null;
  if(pendingDelete===deletingId){pendingDelete=null;$('confirm-dialog').close();}
  renderHistory();renderMessages();queueSave();
});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage().catch(error=>toast(cleanError(error)));}});
$('prompt').addEventListener('input',()=>{$('prompt').style.height='auto';$('prompt').style.height=Math.min($('prompt').scrollHeight,180)+'px';});
document.addEventListener('keydown',e=>{if(mode!=='chat')return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(!document.querySelector('dialog[open]'))actions.search();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();if(!document.querySelector('dialog[open]'))newChat();}});
window.addEventListener('beforeunload',()=>{if(!desktop){clearTimeout(saveTimer);persist();}});
async function initialize(){try{if(desktop){[settings,sessions]=await Promise.all([desktop.getSettings(),desktop.getHistory()]);}else sessions=JSON.parse(localStorage.getItem('deepseek-studio-preview')||'[]');if(!Array.isArray(sessions))sessions=[];sessions=sessions.filter(s=>s&&typeof s.id==='string'&&Array.isArray(s.messages));for(const s of sessions)for(const m of s.messages)if(m.pending){m.pending=false;m.cancelled=true;}}catch(error){toast(cleanError(error));}updateSettingsUI();renderHistory();renderMessages();updateBounds();void refreshModels(true);}
initialize();
refreshHarnessUpdateStatus();

desktop?.onBeforeClose(async()=>{clearTimeout(saveTimer);await persist();await desktop.finishClose();});
