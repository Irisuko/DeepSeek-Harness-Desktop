'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const ChatConfig=require('../renderer/chat-config.js');
const {fetchZenModels}=require('./model-catalog.cjs');
const {validateBaseUrl,validateHarnessUrl,validateModel,validateThinking,validateModelProfiles}=require('./chat-client.cjs');
const DEFAULT_SETTINGS=Object.freeze({model:'',thinking:false,connections:[],modelProfiles:[],theme:'system',harnessUrl:'http://127.0.0.1:3080',workspace:null});
async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      return fallback;
    }
    throw new Error('无法读取本机数据，请检查应用数据目录权限。');
  }
}


class Storage {
  constructor(directory,safeStorage){this.directory=directory;this.safeStorage=safeStorage;this.settings={...DEFAULT_SETTINGS};this.queue=Promise.resolve();}
  async initialize(){
    const file=path.join(this.directory,'settings.json');
    const parsed=await readJson(file,{});
    const stored=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
    this.settings={...DEFAULT_SETTINGS,...this.validateSettings(stored)};
    if(Array.isArray(stored.connections)){
      this.settings.connections=this.validateConnections(stored.connections,true);
    }else{
      // Keep the original encrypted settings for migration recovery; never expose them to the renderer.
      if(stored.encryptedApiKey||stored.modelProfiles?.length){
        await fs.copyFile(file,path.join(this.directory,'settings.before-platforms.json'),fs.constants.COPYFILE_EXCL).catch(error=>{if(error.code!=='EEXIST')throw error;});
      }
      let provider;
      try{provider=ChatConfig.provider(stored.baseUrl||'https://api.deepseek.com');}catch{}
      this.settings.connections=Object.hasOwn(ChatConfig.platforms,provider)&&typeof stored.encryptedApiKey==='string'&&stored.encryptedApiKey.length<=32768
        ?[{provider,baseUrl:ChatConfig.platforms[provider].baseUrl,encryptedApiKey:stored.encryptedApiKey}]:[];
      // Legacy profiles were global. Retain them for recovery, but require an explicit platform before listing them.
      if(stored.thinking===undefined&&stored.model==='deepseek-reasoner')this.settings.thinking=true;
    }
    const zen=this.settings.connections.find(c=>c.provider==='zen');
    const catalog=stored.zenCatalog;
    const models=ChatConfig.sanitizeZenModels(catalog?.models);
    if(zen&&catalog?.baseUrl===zen.baseUrl&&models.length)this.settings.zenCatalog={baseUrl:zen.baseUrl,models};
    this.settings.model=ChatConfig.selectedModel(this.settings);
  }
  validateSettings(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('设置格式无效。');
    const next={};
    if(input.model!==undefined)next.model=input.model===''?'':validateModel(input.model);
    if(input.thinking!==undefined)next.thinking=validateThinking(input.thinking);
    if(input.modelProfiles!==undefined)next.modelProfiles=validateModelProfiles(input.modelProfiles);
    if(input.harnessUrl!==undefined)next.harnessUrl=validateHarnessUrl(input.harnessUrl);
    if(input.theme!==undefined){if(!['system','light','dark'].includes(input.theme))throw new Error('主题无效。');next.theme=input.theme;}
    if(input.workspace!==undefined){
      if(input.workspace!==null&&(typeof input.workspace!=='string'||input.workspace.length>32768||!path.isAbsolute(input.workspace)))throw new Error('项目文件夹路径无效。');
      next.workspace=input.workspace;
    }
    return next;
  }
  validateConnections(input,fromDisk=false){
    if(!Array.isArray(input)||input.length>3)throw new Error('平台配置无效。');
    const seen=new Set();
    return input.map(c=>{
      if(!c||!Object.hasOwn(ChatConfig.platforms,c.provider)||seen.has(c.provider))throw new Error('平台无效或重复添加。');
      seen.add(c.provider);
      const baseUrl=validateBaseUrl(c.baseUrl||ChatConfig.platforms[c.provider].baseUrl);
      if(fromDisk){
        if(typeof c.encryptedApiKey!=='string'||!c.encryptedApiKey||c.encryptedApiKey.length>32768)throw new Error('平台密钥配置无效。');
        return {provider:c.provider,baseUrl,encryptedApiKey:c.encryptedApiKey};
      }
      const old=this.settings.connections.find(p=>p.provider===c.provider&&new URL(p.baseUrl).origin===new URL(baseUrl).origin);
      if(c.apiKey!==undefined&&(typeof c.apiKey!=='string'||c.apiKey.length>4096||/[\r\n]/.test(c.apiKey)))throw new Error('API Key 格式无效。');
      const key=c.apiKey?.trim();
      let encryptedApiKey=old?.encryptedApiKey;
      if(key){
        if(!this.safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，无法保存 API Key。');
        encryptedApiKey=this.safeStorage.encryptString(key).toString('base64');
      }
      if(!encryptedApiKey)throw new Error('请填写 '+ChatConfig.platforms[c.provider].name+' 的 API Key。');
      return {provider:c.provider,baseUrl,encryptedApiKey};
    });
  }
  publicSettings(){
    const {model,thinking,theme,harnessUrl,workspace,modelProfiles,zenCatalog}=this.settings;
    return {model,thinking,theme,harnessUrl,workspace,modelProfiles,zenCatalog,connections:this.settings.connections.map(c=>({provider:c.provider,baseUrl:c.baseUrl,hasApiKey:true})),hasApiKey:this.settings.connections.length>0};
  }
  serialized(operation){const pending=this.queue.then(operation);this.queue=pending.catch(()=>{});return pending;}
  async saveSettings(input){
    return this.serialized(async()=>{
      const next={...this.settings,...this.validateSettings(input)};
      if(input.connections!==undefined)next.connections=this.validateConnections(input.connections);
      if(!next.connections.some(c=>c.provider==='zen'&&c.baseUrl===next.zenCatalog?.baseUrl))delete next.zenCatalog;
      if(input.model&& !ChatConfig.models(next).includes(input.model))throw new Error('此模型没有可用的已添加平台，请先添加平台。');
      next.model=ChatConfig.selectedModel(next);
      await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(next,null,2));
      this.settings=next;return this.publicSettings();
    });
  }
  async refreshModels(fetchImpl){
    const before=this.settings.connections.find(c=>c.provider==='zen');
    if(!before)return this.publicSettings();
    const models=await fetchZenModels(this.getPlatformConnection('zen'),fetchImpl);
    return this.serialized(async()=>{
      const current=this.settings.connections.find(c=>c.provider==='zen');
      // A slow response must not resurrect a removed platform or override a new connection.
      if(!current||current.baseUrl!==before.baseUrl||current.encryptedApiKey!==before.encryptedApiKey)return this.publicSettings();
      const next={...this.settings,zenCatalog:{baseUrl:current.baseUrl,models}};
      next.model=ChatConfig.selectedModel(next);
      await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(next,null,2));
      this.settings=next;
      return this.publicSettings();
    });
  }
  getChatConnection(model=this.settings.model){
    if(!ChatConfig.models(this.settings).includes(model))throw new Error('请先添加支持此模型的平台。');
    const route=ChatConfig.route(this.settings,model);
    if(!route)throw new Error('请先添加支持此模型的平台。');
    const {apiKey}=this.getPlatformConnection(route.provider);
    return {apiKey,model:route.model,baseUrl:route.baseUrl,apiProtocol:route.protocol,modelProfiles:[{model:route.model,protocol:route.protocol,thinkingMode:route.thinkingMode}]};
  }
  getPlatformConnection(provider){
    const connection=this.settings.connections.find(c=>c.provider===provider);
    if(!connection)throw new Error('请先添加支持此模型的平台。');
    if(!this.safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，请重新打开应用。');
    let apiKey;
    try{apiKey=this.safeStorage.decryptString(Buffer.from(connection.encryptedApiKey,'base64'));}
    catch{throw new Error('无法解密 '+ChatConfig.platforms[provider].name+' 的密钥，请在设置中重新填写。');}
    return {provider,baseUrl:connection.baseUrl,apiKey};
  }
  getHarnessSettings(){
    return {...this.publicSettings(),connections:this.settings.connections.map(c=>this.getPlatformConnection(c.provider))};
  }
  async getHistory() {
    const history = await readJson(path.join(this.directory, 'history.json'), []);
    return Array.isArray(history) ? history : [];
  }

  saveHistory(sessions) {
    if (!Array.isArray(sessions) || sessions.length > 500 || sessions.some((session) => !session || typeof session !== 'object' || Array.isArray(session))) {
      throw new Error('历史记录格式无效，最多支持 500 个对话。');
    }
    const content = JSON.stringify(sessions);
    if (Buffer.byteLength(content, 'utf8') > 25 * 1024 * 1024) throw new Error('历史记录超过 25 MB，请清理部分旧对话。');
    return this.serialized(async () => {
      await atomicWrite(path.join(this.directory, 'history.json'), content);
      return { saved: true };
    });
  }
}


module.exports={Storage,DEFAULT_SETTINGS,atomicWrite};
