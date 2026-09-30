'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Storage}=require('../storage.cjs');
const Config=require('../../renderer/chat-config.js');
const safeStorage={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from([...v].reverse().join('')),decryptString:v=>[...v.toString()].reverse().join('')};
async function fixture(t,safe=safeStorage){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'deepseek-connections-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new Storage(dir,safe);await store.initialize();return store;}
const add=provider=>({provider,baseUrl:Config.platforms[provider].baseUrl,apiKey:provider+'-fixture-secret'});
test('Empty configuration has no models; multiple encrypted credentials survive restart without disclosure',async t=>{
 const store=await fixture(t);assert.deepEqual(Config.models(store.publicSettings()),[]);
 const settings=await store.saveSettings({connections:['deepseek','go','zen'].map(add)});
 const disk=await fs.readFile(path.join(store.directory,'settings.json'),'utf8');
 for(const id of ['deepseek','go','zen']){assert.ok(!disk.includes(id+'-fixture-secret'));assert.ok(!JSON.stringify(settings).includes(id+'-fixture-secret'));}
 assert.ok(!JSON.stringify(settings).includes('encryptedApiKey'));
 const next=new Storage(store.directory,safeStorage);await next.initialize();
 assert.equal(next.getChatConnection('deepseek-v4.1-flash').apiKey,'deepseek-fixture-secret');
 assert.equal(next.getChatConnection('gpt-6-astra').apiKey,'zen-fixture-secret');
});
test('All platform combinations expose exactly their model groups, without stale current or global custom entries',()=>{
 const ds=['deepseek-v4.1-flash','deepseek-v4-pro'],zen=['gpt-6-astra','gpt-6.1-sol','gpt-6-luna','claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5'];
 for(let mask=0;mask<8;mask++){
   const providers=['deepseek','go','zen'].filter((p,i)=>mask&(1<<i));
   const config={connections:providers.map(add),model:'claude-fable-5',modelProfiles:[{model:'claude-fable-5',protocol:'messages',thinkingMode:'none'}]};
   const expected=[...(providers.includes('zen')?zen:[]),...(providers.some(p=>p!=='zen')?ds:[])];
   assert.deepEqual(Config.models(config),expected);
   assert.equal(Config.selectedModel(config),expected[0]||'');
 }
});
test('Routes each model to the correct key, protocol and provider-specific Flash ID',async t=>{
 const store=await fixture(t);await store.saveSettings({connections:['zen','go','deepseek'].map(add)});
 let route=store.getChatConnection('deepseek-v4.1-flash');assert.equal(route.model,'deepseek-flash');assert.equal(route.apiKey,'deepseek-fixture-secret');assert.equal(route.apiProtocol,'chat');
 assert.equal(store.getChatConnection('deepseek-v4-pro').apiKey,'deepseek-fixture-secret');
 for(const model of ['gpt-6-astra','gpt-6.1-sol','gpt-6-luna','claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5']){route=store.getChatConnection(model);assert.equal(route.apiKey,'zen-fixture-secret');assert.equal(route.apiProtocol,model.startsWith('claude')?'messages':'responses');}
 await store.saveSettings({connections:store.publicSettings().connections.filter(c=>c.provider!=='deepseek')});
 route=store.getChatConnection('deepseek-v4.1-flash');assert.equal(route.model,'deepseek-v4.1-flash');assert.equal(route.apiKey,'go-fixture-secret');
 assert.deepEqual(Config.candidates(store.settings,'deepseek-v4-pro').map(c=>c.provider),['go','zen']);
 assert.equal(Config.route({connections:[add('zen')]},'deepseek-v4-pro').provider,'zen');
 await store.saveSettings({connections:[store.publicSettings().connections.find(c=>c.provider==='zen')]});
 assert.throws(()=>store.getChatConnection('deepseek-v4.1-flash'),/请先添加/);
});
test('Removing Zen hides Fable and GPT; custom models only appear with their explicit platform',async t=>{
 const store=await fixture(t);await store.saveSettings({connections:['go','zen'].map(add),modelProfiles:[{model:'claude-fable-5',provider:'zen',protocol:'messages',thinkingMode:'none'}],model:'claude-fable-5'});
 assert.equal(store.getChatConnection('claude-fable-5').apiKey,'zen-fixture-secret');
 const saved=await store.saveSettings({connections:[store.publicSettings().connections.find(c=>c.provider==='go')]});
 assert.deepEqual(Config.models(saved),['deepseek-v4.1-flash','deepseek-v4-pro']);assert.equal(saved.model,'deepseek-v4.1-flash');
 assert.throws(()=>store.getChatConnection('claude-fable-5'),/请先添加/);
 await store.saveSettings({connections:[]});assert.equal(store.publicSettings().model,'');assert.deepEqual(Config.models(store.publicSettings()),[]);
});
test('Invalid, duplicate, unsupported or rehosted platform updates are atomic',async t=>{
 const store=await fixture(t);await store.saveSettings({connections:[add('go')]});
 const old=await fs.readFile(path.join(store.directory,'settings.json'),'utf8');
 for(const connections of [[add('go'),add('go')],[{provider:'openai',apiKey:'s'}],[{provider:'zen'}],[{provider:'go',baseUrl:'https://other.example/v1'}],[{...add('go'),apiKey:'bad\nkey'}]])await assert.rejects(store.saveSettings({connections}));
 assert.equal(await fs.readFile(path.join(store.directory,'settings.json'),'utf8'),old);
 await store.saveSettings({connections:[{...store.publicSettings().connections[0],apiKey:'replacement'}]});assert.equal(store.getChatConnection('deepseek-v4-pro').apiKey,'replacement');
});
test('Encryption failure preserves configuration, concurrent saves preserve history and connections',async t=>{
 const store=await fixture(t);await store.saveSettings({connections:[add('go')]});
 store.safeStorage={...safeStorage,isEncryptionAvailable:()=>false};await assert.rejects(store.saveSettings({connections:[add('zen')]}),/安全存储/);
 store.safeStorage=safeStorage;
 await Promise.all([store.saveSettings({theme:'dark'}),store.saveSettings({model:'deepseek-v4-pro',thinking:true}),store.saveHistory([{id:'one',messages:[]}])]);
 assert.equal(store.publicSettings().theme,'dark');assert.equal(store.publicSettings().thinking,true);assert.equal(store.getChatConnection().apiKey,'go-fixture-secret');assert.equal((await store.getHistory())[0].id,'one');
});
test('Legacy official and OpenCode keys migrate once; stale global models remain hidden and original settings are backed up',async t=>{
 const store=await fixture(t);const file=path.join(store.directory,'settings.json');
 const old={baseUrl:'https://opencode.ai/zen/go/v1/chat/completions',model:'claude-fable-5',encryptedApiKey:safeStorage.encryptString('legacy').toString('base64'),modelProfiles:[{model:'claude-fable-5',protocol:'messages',thinkingMode:'none'}]};
 await fs.writeFile(file,JSON.stringify(old));await store.initialize();
 assert.deepEqual(Config.models(store.publicSettings()),['deepseek-v4.1-flash','deepseek-v4-pro']);assert.equal(store.getChatConnection().apiKey,'legacy');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.directory,'settings.before-platforms.json'))),old);
 await store.saveSettings({theme:'dark'});const next=new Storage(store.directory,safeStorage);await next.initialize();assert.equal(next.getChatConnection().apiKey,'legacy');
 await store.saveSettings({connections:[]});await store.initialize();assert.equal(store.publicSettings().connections.length,0);
});
test('Removed OpenAI and Anthropic credentials never migrate to Zen; malformed JSON remains recoverable',async t=>{
 const store=await fixture(t);const file=path.join(store.directory,'settings.json');
 for(const host of ['api.openai.com','api.anthropic.com']){await fs.writeFile(file,JSON.stringify({baseUrl:'https://'+host+'/v1',encryptedApiKey:'bGVnYWN5'}));await store.initialize();assert.deepEqual(store.publicSettings().connections,[]);}
 await fs.writeFile(file,'{invalid');await store.initialize();assert.deepEqual(store.publicSettings().connections,[]);assert.ok((await fs.readdir(store.directory)).some(f=>f.includes('.corrupt-')));
 await fs.writeFile(file,'null');await store.initialize();assert.deepEqual(store.publicSettings().connections,[]);
});

test('Scoped custom models retain automatic Zen protocols and built-in routing priority',async t=>{
 const store=await fixture(t);
 await store.saveSettings({connections:['go','zen'].map(add),modelProfiles:[
  {model:'gpt-custom',provider:'zen',protocol:'auto',thinkingMode:'none'},
  {model:'claude-custom',provider:'zen',protocol:'auto',thinkingMode:'none'},
  {model:'gpt-6-astra',provider:'go',protocol:'chat',thinkingMode:'none'}
 ]});
 assert.equal(store.getChatConnection('gpt-custom').apiProtocol,'responses');
 assert.equal(store.getChatConnection('claude-custom').apiProtocol,'messages');
 assert.equal(store.getChatConnection('gpt-6-astra').apiKey,'zen-fixture-secret');
 assert.equal(store.getChatConnection('gpt-6-astra').apiProtocol,'responses');
 assert.equal(Config.isBuiltIn('gpt-6-astra'),true);
 assert.equal(Config.isBuiltIn('gpt-custom'),false);
});
