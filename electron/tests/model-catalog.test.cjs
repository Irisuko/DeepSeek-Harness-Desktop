'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Storage}=require('../storage.cjs');
const {fetchZenModels}=require('../model-catalog.cjs');
const {streamChat}=require('../chat-client.cjs');
const {buildHarnessConnections}=require('../harness-connections.cjs');
const Config=require('../../renderer/chat-config.js');
const safe={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()};
const catalog=ids=>new Response(JSON.stringify({data:ids.map(id=>({id}))}));
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'deepseek-models-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Storage(dir,safe);await store.initialize();
  await store.saveSettings({connections:[{provider:'zen',apiKey:'fixture-private-key'}]});
  return store;
}

test('Public catalog needs no key; proxy uses saved key at the configured root and rejects redirects',async()=>{
  for(const baseUrl of ['https://opencode.ai/zen/v1','https://proxy.example/v1/responses']){
    const ids=await fetchZenModels({baseUrl,apiKey:'fixture-private-key'},async(url,options)=>{
      assert.equal(url,baseUrl.replace('/responses','')+'/models');
      assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Authorization,baseUrl.includes('proxy')?'Bearer fixture-private-key':undefined);
      return catalog(['gpt-6.1-sol','claude-sonnet-5-5']);
    });
    assert.deepEqual(ids,['gpt-6.1-sol','claude-sonnet-5-5']);
  }
});

test('Refresh discovers future models, filters unsupported IDs, persists and shares identical routes with Harness',async t=>{
  const store=await fixture(t);
  const saved=await store.refreshModels(async()=>catalog(['gpt-7-sol','claude-sonnet-6','gpt-7-sol','gpt-image-2','gpt-7-audio','gemini-3-flash','bad\nmodel',null]));
  assert.deepEqual(Config.models(saved),['gpt-7-sol','claude-sonnet-6','gpt-6-astra']); // Existing preset selection stays usable.
  assert.equal(Config.isBuiltIn('gpt-7-sol',saved),true);
  assert.equal(store.getChatConnection('gpt-7-sol').apiProtocol,'responses');
  assert.equal(store.getChatConnection('claude-sonnet-6').apiProtocol,'messages');
  await store.saveSettings({model:'claude-sonnet-6',modelProfiles:[{model:'claude-sonnet-6',provider:'zen',protocol:'messages',thinkingMode:'adaptive'}]});
  const next=new Storage(store.directory,safe);await next.initialize();
  assert.equal(next.getChatConnection().model,'claude-sonnet-6');
  const {patch}=buildHarnessConnections(next.getHarnessSettings());
  const providers=patch.find(p=>p.id==='llm-pi-ai').config.providers;
  assert.ok(providers['desktop-zen-responses'].models.some(m=>m.id==='gpt-7-sol'));
  assert.equal(providers['desktop-zen-messages'].models.find(m=>m.id==='claude-sonnet-6').compat.forceAdaptiveThinking,true);
  assert.deepEqual(patch.find(p=>p.id==='agent-default-model').config,{provider:'desktop-zen-messages',model:'claude-sonnet-6'});
  assert.ok(!JSON.stringify(next.publicSettings()).includes('fixture-private-key'));
});

test('Malformed, failed and oversized catalogs preserve the previous cache without exposing service errors',async t=>{
  const store=await fixture(t);
  await store.refreshModels(async()=>catalog(['gpt-6.1-sol','claude-sonnet-5-5']));
  const disk=await fs.readFile(path.join(store.directory,'settings.json'),'utf8');
  for(const fetchImpl of [
    async()=>new Response('fixture-private-key',{status:401}),
    async()=>new Response('{bad'),async()=>catalog([]),async()=>catalog(['gemini-3-flash']),
    async()=>new Response('x'.repeat(1024*1024+1)),async()=>{throw new Error('fixture-private-key');},
  ]){
    await assert.rejects(store.refreshModels(fetchImpl),error=>error.message.includes('保留缓存')&&!error.message.includes('fixture-private-key'));
    assert.equal(await fs.readFile(path.join(store.directory,'settings.json'),'utf8'),disk);
  }
});

test('Slow refresh never resurrects a removed or changed Zen connection',async t=>{
  for(const change of ['remove','url','key']){
    const store=await fixture(t);
    let complete;
    const pending=store.refreshModels(()=>new Promise(resolve=>{complete=resolve;}));
    const connections=change==='remove'?[]:[{provider:'zen',baseUrl:change==='url'?'https://proxy.example/v1':Config.platforms.zen.baseUrl,apiKey:'new-key'}];
    await store.saveSettings({connections});
    complete(catalog(['gpt-7-sol']));await pending;
    assert.equal(store.publicSettings().zenCatalog,undefined);
    assert.ok(!Config.models(store.publicSettings()).includes('gpt-7-sol'));
  }
});

test('Offline upgrades keep old selected presets, explicit custom models and cached platform binding',async t=>{
  const store=await fixture(t);
  await store.saveSettings({model:'gpt-5.6-sol',modelProfiles:[{model:'my-model',provider:'zen',protocol:'chat',thinkingMode:'none'}]});
  assert.equal(store.publicSettings().model,'gpt-5.6-sol');
  await store.refreshModels(async()=>catalog(['gpt-6.1-sol']));
  assert.ok(Config.models(store.publicSettings()).includes('my-model'));
  assert.equal(store.getChatConnection().model,'gpt-5.6-sol');
  await store.saveSettings({connections:[{provider:'zen',baseUrl:'https://other.example/v1',apiKey:'new-key'}]});
  assert.equal(store.publicSettings().zenCatalog,undefined);
  assert.ok(Config.models(store.publicSettings()).includes('claude-sonnet-5-5'));
});

test('Every current preset reaches its Chat endpoint with the model ID, history and correct authentication',async t=>{
  const store=await fixture(t);
  for(const model of Config.models(store.publicSettings())){
    const events=[];
    const messages=[{role:'user',content:'Hello'},{role:'assistant',content:'Hi'},{role:'user',content:'Continue'}];
    const connection=store.getChatConnection(model);
    await streamChat({...connection,messages,thinking:false,onEvent:e=>events.push(e),fetchImpl:async(url,options)=>{
      const claude=model.startsWith('claude-');
      assert.equal(url,Config.platforms.zen.baseUrl+(claude?'/messages':'/responses'));
      assert.equal(options.headers[claude?'x-api-key':'Authorization'],claude?'fixture-private-key':'Bearer fixture-private-key');
      const body=JSON.parse(options.body);
      assert.equal(body.model,model);assert.deepEqual(body[claude?'messages':'input'],messages);
      assert.equal(body.thinking,undefined);assert.equal(body.reasoning,undefined);
      const stream=claude
        ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
      return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
    }});
    assert.deepEqual(events,[{type:'delta',text:'ok'}]);
  }
});
