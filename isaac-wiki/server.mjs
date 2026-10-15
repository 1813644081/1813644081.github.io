import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {JobIndex} from './scheduler.mjs';

const require=createRequire(import.meta.url);
const M=require('./shared.js');
const root=path.dirname(fileURLToPath(import.meta.url));
const PORT=8765;
const localOrigin=`http://127.0.0.1:${PORT}`;
const digest=value=>createHash('sha256').update(value).digest('hex');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'";
const ENGINE_VERSION='2.0.0';

export async function createMirror(directory=root) {
  const dataDir=path.join(directory,'data'),siteDir=path.join(directory,'site');
  await Promise.all(['data','site/pages','site/assets','logs','extension'].map(p=>fs.mkdir(path.join(directory,p),{recursive:true})));
  const tokenPath=path.join(directory,'.mirror-token');
  let token;
  try {token=(await fs.readFile(tokenPath,'utf8')).trim();}catch{token=randomBytes(32).toString('hex');await fs.writeFile(tokenPath,token,{mode:0o600});}
  await fs.writeFile(path.join(directory,'extension/config.json'),JSON.stringify({token}));
  try {await fs.copyFile(path.join(directory,'shared.js'),path.join(directory,'extension/shared.js'));}catch(e){if(directory===root)throw e;}
  const statePath=path.join(dataDir,'state.json');
  const journalPath=path.join(dataDir,'progress.jsonl');
  let state;
  try {state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,running:false,started:null,namespaces:null,jobs:{},pages:{},assets:{},rejected:{},lastError:null};}
  state._seq||=0;
  let interruptedTail=false;
  function replay(line,last=false){
      let patch;
      try{patch=JSON.parse(line);}catch(e){if(last){interruptedTail=true;return;}throw e;}
      if(patch.seq<=state._seq)return;
      Object.assign(state,patch.meta);
      for(const key of ['jobs','pages','assets','rejected'])Object.assign(state[key],patch[key]);
      state._seq=patch.seq;
  }
  try {
    const lines=readline.createInterface({input:createReadStream(journalPath,{encoding:'utf8'}),crlfDelay:Infinity});
    let previous;
    // Delay one nonempty line so an interrupted final append can still be ignored.
    for await(const line of lines){if(!line.trim())continue;if(previous!==undefined)replay(previous);previous=line;}
    if(previous!==undefined)replay(previous,true);
  } catch(e){if(e.code!=='ENOENT')throw e;}
  if(interruptedTail){
    // Publish the valid replayed state before removing the partial record. Future
    // appends must not turn that interrupted tail into an invalid interior line.
    await fs.writeFile(statePath+'.tmp',JSON.stringify(state));await fs.rename(statePath+'.tmp',statePath);await fs.writeFile(journalPath,'');
  }
  const metaKeys=['running','started','namespaces','siteinfo','lastError'];
  const savedMeta=Object.fromEntries(metaKeys.map(key=>[key,state[key]]));
  state.running=false;
  const dirty={jobs:new Set(),pages:new Set(),assets:new Set(),rejected:new Set()};
  for(const [id,job]of Object.entries(state.jobs))if(job.status==='leased'){job.status='pending';delete job.leaseUntil;dirty.jobs.add(id);}
  const index=new JobIndex(state.jobs);
  let pageCount=Object.keys(state.pages).length,assetCount=Object.keys(state.assets).length,rejectedCount=Object.keys(state.rejected).length;
  let assetBytes=Object.values(state.assets).reduce((n,a)=>n+a.bytes,0);
  const wrapJob=(key,job)=>new Proxy(job,{set(target,prop,value){const previous=target[prop];target[prop]=value;if(prop==='status')index.changed(key,target,previous,value);dirty.jobs.add(key);return true;},deleteProperty(target,prop){delete target[prop];dirty.jobs.add(key);return true;}});
  for(const [key,job]of Object.entries(state.jobs))state.jobs[key]=wrapJob(key,job);
  for(const name of Object.keys(dirty))state[name]=new Proxy(state[name],{set(target,key,value){
    const exists=Object.hasOwn(target,key),previous=target[key];
    if(name==='jobs'){if(exists)throw new Error('不允许覆盖已有下载任务');target[key]=wrapJob(key,value);index.register(key,target[key]);}
    else {target[key]=value;if(name==='pages'&&!exists)pageCount++;if(name==='rejected'&&!exists)rejectedCount++;if(name==='assets'){if(!exists)assetCount++;assetBytes+=(value.bytes||0)-(previous?.bytes||0);}}
    dirty[name].add(key);return true;
  }});
  let saveChain=Promise.resolve();
  function save({checkpoint=false}={}){
    const meta={};for(const key of metaKeys)if(state[key]!==savedMeta[key]){meta[key]=state[key];savedMeta[key]=state[key];}
    const patch={seq:++state._seq,meta};
    for(const name of Object.keys(dirty)){patch[name]=Object.fromEntries([...dirty[name]].map(key=>[key,state[name][key]]));dirty[name].clear();}
    const line=JSON.stringify(patch)+'\n';
    // Journal each change; avoid rewriting the entire large archive manifest for every image.
    const snapshot=checkpoint||state._seq%500===0?JSON.stringify(state):null;
    saveChain=saveChain.then(async()=>{
      await fs.appendFile(journalPath,line);
      if(snapshot){
        await fs.writeFile(statePath+'.tmp',snapshot);await fs.rename(statePath+'.tmp',statePath);
        // Later appends are queued behind this checkpoint. A crash before clearing
        // leaves duplicate journal records, which replay skips using snapshot _seq.
        await fs.writeFile(journalPath,'');
      }
    });return saveChain;
  }
  function add(kind,url='',extra={}) {
    if(url&&!M.absolute(url,M.ORIGIN)) {state.rejected[url]='地址不在允许的原站素材域名范围';return;}
    const id=digest(kind+'\n'+url+'\n'+(extra.title||''));
    if(!state.jobs[id])state.jobs[id]={id,kind,url,...extra,status:'pending',attempts:0};
  }
  function api(params){return M.ORIGIN+'/api.php?'+new URLSearchParams({format:'json',formatversion:'2',maxlag:'5',...params});}
  function reject(urls){for(const url of urls||[])state.rejected[url]='资源域名未允许，尚未下载';}
  function asset(url){const u=M.absolute(url,M.ORIGIN);if(!u){reject([url]);return;}u.hash='';add('asset',u.href);}
  function stats(){
    const pending=index.status.pending||0,active=index.status.leased||0,failed=index.status.failed||0;
    const enumerationDone=!!state.namespaces&&index.enumerationRemaining===0;
    return {engineVersion:ENGINE_VERSION,dataDirectory:path.resolve(directory),running:state.running,pages:pageCount,assets:assetCount,pending,active,failed,rejected:rejectedCount,totalJobs:index.total,enumerationDone,complete:enumerationDone&&pending===0&&active===0&&failed===0&&rejectedCount===0,lastError:state.lastError,started:state.started,bytes:assetBytes,pendingPages:index.pages.pending||0,activePages:index.pages.leased||0,pendingAssets:index.assets.pending||0,activeAssets:index.assets.leased||0,shuttingDown:shutdownRequested,perf:{scheduler:'indexed',journal:'streaming-delta',checkpointEvery:500}};
  }
  async function accept(id,result){
    const job=state.jobs[id];if(!job)throw new Error('未知任务');
    if(job.status==='done')return;
    if(job.status!=='leased')throw new Error('任务尚未领取');
    if(job.kind==='siteinfo') {
      const namespaces=result.query?.namespaces;
      if(!namespaces||!result.query?.general)throw new Error('原站站点信息响应无效');
      state.namespaces=Object.values(namespaces).map(n=>({id:n.id,name:n.name??n['*']??''})).filter(n=>Number.isInteger(n.id)&&n.id>=0);
      state.siteinfo=result.query;
      for(const ns of state.namespaces)add('allpages',api({action:'query',list:'allpages',apnamespace:String(ns.id),aplimit:'500'}),{ns:ns.id});
      add('allimages',api({action:'query',list:'allimages',ailimit:'500',aiprop:'url|size|mime'}));
    } else if(job.kind==='allpages') {
      if(!Array.isArray(result.query?.allpages))throw new Error('页面目录响应无效');
      for(const page of result.query.allpages){const title=M.normalizeTitle(page.title);add('page',M.ORIGIN+'/index.php?'+new URLSearchParams({title}),{title,pageid:page.pageid,ns:page.ns});}
      if(result.continue)add('allpages',api({action:'query',list:'allpages',apnamespace:String(job.ns),aplimit:'500',...result.continue}),{ns:job.ns});
    } else if(job.kind==='allimages') {
      if(!Array.isArray(result.query?.allimages))throw new Error('上传文件目录响应无效');
      for(const image of result.query.allimages)if(image.url)asset(image.url);
      if(result.continue)add('allimages',api({action:'query',list:'allimages',ailimit:'500',aiprop:'url|size|mime',...result.continue}));
    } else if(job.kind==='page'||job.kind==='seed') {
      if(typeof result.html!=='string'||!result.html.startsWith('<!doctype html>'))throw new Error('导出的 HTML 格式无效');
      const title=job.title||'首页',name=digest(title)+'.html';
      await fs.writeFile(path.join(siteDir,'pages',name),result.html);
      state.pages[title]={file:name,source:job.url||M.ORIGIN+'/wiki/'+encodeURIComponent(title),savedAt:new Date().toISOString(),pageid:job.pageid,ns:job.ns??0};
      for(const url of result.assets||[])asset(url);reject(result.rejected);
    } else if(job.kind==='asset') {
      const mime=String(result.mime||'application/octet-stream');
      if(/[\r\n]/.test(mime)||/text\/html/i.test(mime))throw new Error('资源类型无效');
      const bytes=typeof result.text==='string'?Buffer.from(result.text):typeof result.base64==='string'?Buffer.from(result.base64,'base64'):null;
      if(!bytes)throw new Error('资源数据为空');
      const name=digest(job.url)+'.asset';
      await fs.writeFile(path.join(siteDir,'assets',name),bytes);
      state.assets[name]={url:job.url,mime,bytes:bytes.length,savedAt:new Date().toISOString()};
      for(const url of result.assets||[])asset(url);reject(result.rejected);
    }
    job.status='done';job.finished=new Date().toISOString();delete job.leaseUntil;
    state.lastError=null;
    if(stats().complete)state.running=false;
    await save();
  }
  async function next(kind){
    if(!state.running)return null;
    const now=Date.now();index.expire(now);
    const job=index.take(kind);
    if(!job)return null;
    job.status='leased';job.leaseUntil=now+180000;job.attempts++;await save();return {...job};
  }
  let shutdownRequested=false;
  async function control(action){
    if(action==='start') {
      state.running=true;state.started||=new Date().toISOString();
      add('seed','',{title:'首页'});
      add('siteinfo',api({action:'query',meta:'siteinfo',siprop:'general|namespaces|statistics'}));
    } else if(action==='pause')state.running=false;
    else if(action==='retry'){for(const job of Object.values(state.jobs))if(job.status==='failed'){job.status='pending';job.attempts=0;}state.lastError=null;}
    else if(action==='checkpoint'){await save({checkpoint:true});return stats();}
    else if(action==='shutdown'){
      state.running=false;shutdownRequested=true;await save({checkpoint:true});
      setImmediate(()=>{server.close(async()=>{await saveChain;server.emit('mirror-shutdown');});server.closeIdleConnections?.();});
      return stats();
    }
    else throw new Error('未知控制动作');
    await save();return stats();
  }
  async function failure(id,error,blocked){
    const job=state.jobs[id];if(!job||job.status==='done')return;
    job.error=String(error).slice(0,1000);job.status=blocked||job.attempts<3?'pending':'failed';delete job.leaseUntil;
    state.lastError=job.error;if(blocked)state.running=false;
    await fs.appendFile(path.join(directory,'logs/errors.jsonl'),JSON.stringify({time:new Date().toISOString(),id,url:job.url,error:job.error})+'\n');
    await save();
  }
  async function readBody(req){
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>96*1024*1024)throw new Error('上传内容过大');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  }
  const authorized=req=>{
    const supplied=req.headers['x-mirror-token'];
    return typeof supplied==='string'&&/^[a-f0-9]{64}$/.test(supplied)&&supplied.length===token.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
  };
  function json(res,value,status=200){res.writeHead(status,{'Content-Type':types['.json'],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
  async function sendFile(res,file,mime){
    const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime||types[path.extname(file)]||'application/octet-stream','Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(bytes);
  }
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.host!==`127.0.0.1:${server.address()?.port??PORT}`){json(res,{error:'只接受本机地址'},403);return;}
      const url=new URL(req.url,localOrigin),route=url.pathname;
      if(route.startsWith('/api/')) {
        if(!authorized(req)){json(res,{error:'本地配对密钥无效'},403);return;}
        const origin=req.headers.origin;
        if(origin&&origin!==localOrigin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)){json(res,{error:'请求来源不允许'},403);return;}
        if(req.method==='GET'&&route==='/api/status')json(res,stats());
        else if(req.method==='GET'&&route==='/api/next')json(res,await next(url.searchParams.get('kind')||undefined));
        else if(req.method==='GET'&&route==='/api/seed')json(res,{source:await fs.readFile(path.join(directory,'isaac-wiki-source.html'),'utf8')});
        else if(req.method==='GET'&&route==='/api/errors')json(res,{failed:Object.values(state.jobs).filter(j=>j.status==='failed').map(j=>({kind:j.kind,title:j.title,url:j.url,error:j.error})),rejected:state.rejected});
        else if(req.method==='POST'&&route==='/api/control')json(res,await control((await readBody(req)).action));
        else if(req.method==='POST'&&route==='/api/result'){const body=await readBody(req);await accept(body.id,body.result);json(res,{ok:true});}
        else if(req.method==='POST'&&route==='/api/failure'){const body=await readBody(req);await failure(body.id,body.error,body.blocked);json(res,{ok:true});}
        else if(req.method==='POST'&&route==='/api/import-seed') {
          const body=await readBody(req);add('seed','',{title:'首页'});
          const job=Object.values(state.jobs).find(j=>j.kind==='seed');
          job.status='leased';await accept(job.id,body);json(res,{ok:true});
        } else json(res,{error:'接口不存在'},404);
        return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD'){json(res,{error:'不支持的方法'},405);return;}
      if(route==='/client-config.js'){
        if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])){json(res,{error:'只接受同源请求'},403);return;}
        res.writeHead(200,{'Content-Type':types['.js'],'Cache-Control':'no-store'});res.end('window.MIRROR_TOKEN='+JSON.stringify(token)+';');return;
      }
      if(route==='/'||route==='/index.html'){await sendFile(res,path.join(directory,'dashboard.html'));return;}
      if(route==='/wiki'||route==='/wiki/'){res.writeHead(302,{Location:'/wiki/'+encodeURIComponent('首页')});res.end();return;}
      if(route.startsWith('/wiki/')) {
        const title=M.normalizeTitle(decodeURIComponent(route.slice(6))),page=state.pages[title];
        if(page){res.writeHead(302,{Location:'/pages/'+page.file});res.end();return;}
        res.writeHead(404,{'Content-Type':types['.html'],'Content-Security-Policy':CSP});res.end(`<!doctype html><meta charset="utf-8"><title>条目尚未下载</title><h1>${M.escape(title)}</h1><p>该条目尚未下载，或属于动态特殊页面。</p><a href="/">查看下载进度</a> · <a href="${M.ORIGIN}/wiki/${encodeURIComponent(title)}">联网查看原站</a>`);return;
      }
      if(route==='/search') {
        const q=(url.searchParams.get('q')||'').slice(0,200),query=q.toLocaleLowerCase();
        const titles=Object.keys(state.pages).filter(t=>t.toLocaleLowerCase().includes(query)).sort((a,b)=>a.localeCompare(b,'zh-CN'));
        res.writeHead(200,{'Content-Type':types['.html'],'Content-Security-Policy':CSP});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/offline.css"><title>离线条目搜索</title><main class="offline-main"><a href="/wiki/${encodeURIComponent('首页')}">返回 Wiki 首页</a><h1>已下载条目搜索</h1><form action="/search"><input name="q" value="${M.escape(q)}" aria-label="关键词"><button>搜索</button></form><p>匹配 ${titles.length} 个条目（搜索标题）</p><ul>${titles.slice(0,1000).map(t=>`<li><a href="/wiki/${encodeURIComponent(t)}">${M.escape(t)}</a></li>`).join('')}</ul>${titles.length>1000?'<p>显示前 1000 个结果，请缩小关键词范围。</p>':''}</main></html>`);return;
      }
      const staticFiles=new Set(['/dashboard.js','/dashboard.css','/shared.js','/offline.js','/offline.css','/import.html','/import.js']);
      if(staticFiles.has(route)){await sendFile(res,path.join(directory,route.slice(1)));return;}
      const match=route.match(/^\/(pages|assets)\/([a-f0-9]{64}\.(html|asset))$/);
      if(match){const mime=match[1]==='assets'?state.assets[match[2]]?.mime:types['.html'];if(!mime){json(res,{error:'资源尚未下载'},404);return;}await sendFile(res,path.join(siteDir,match[1],match[2]),mime);return;}
      json(res,{error:'文件不存在'},404);
    } catch(e){if(!res.headersSent)json(res,{error:e.code==='ENOENT'?'文件尚未保存':e.message},e.code==='ENOENT'?404:400);else res.end();}
  });
  return {server,state,stats,control,next,accept,failure,save,token,directory};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mirror=await createMirror();
  mirror.server.once('mirror-shutdown',()=>process.exit(0));
  mirror.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口 8765 已被占用；如果本地站点已运行，请直接打开它。':e);process.exitCode=1;});
  mirror.server.listen(PORT,'127.0.0.1',async()=>{await fs.writeFile(path.join(root,'server.pid'),String(process.pid));console.log('以撒离线 Wiki 本地服务：'+localOrigin+'\n当前内容：'+mirror.stats().pages+' 个页面。全站下载尚需 Chrome 导出助手。');});
  async function shutdown(){await mirror.control('shutdown');}
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
