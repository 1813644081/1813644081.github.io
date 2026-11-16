import http from 'node:http';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';

const root=path.dirname(fileURLToPath(import.meta.url));
const original='https://isaac.huijiwiki.com';
const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'";
const html='text/html; charset=utf-8';
const css='text/css; charset=utf-8';
const js='text/javascript; charset=utf-8';
const json='application/json; charset=utf-8';
const pageFilename=/^[a-f0-9]{64}\.html$/;
const files=new Map([['/offline.css',css],['/offline.js',js],['/wiki-player.js',js]]);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function createReader(directory=root) {
  const site=path.join(directory,'site');
  const catalogue=JSON.parse(await fs.readFile(path.join(site,'catalog.json'),'utf8'));
  if(catalogue.version!==1||!catalogue.pages||!catalogue.assets||!pageFilename.test(catalogue.pages['首页']))throw new Error('离线索引缺失或格式错误。');
  const {pages,assets}=catalogue;
  function headers(res,type,status=200,extra={}) {
    res.writeHead(status,{'Content-Type':type,'Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache',...extra});
  }
  function content(req,res,type,body,status=200) {
    headers(res,type,status,{'Content-Length':Buffer.byteLength(body)});
    res.end(req.method==='HEAD'?undefined:body);
  }
  async function send(req,res,file,type) {
    const info=await fs.stat(file);
    if(!info.isFile())return content(req,res,'text/plain; charset=utf-8','文件不存在',404);
    headers(res,type,200,{'Content-Length':info.size});
    if(req.method==='HEAD')return res.end();
    await pipeline(createReadStream(file),res);
  }
  async function article(req,res,name) {
    if(!pageFilename.test(name))return content(req,res,'text/plain; charset=utf-8','页面不存在',404);
    let text=(await fs.readFile(path.join(site,'pages',name),'utf8'))
      .replace(/<a href="(?:\.\.\/|\/progress)">下载进度<\/a>/g,'')
      .replace('动画播放器、登录、编辑及其他服务器功能未包含在静态版中。','登录、编辑及其他服务器功能未包含在离线版中。');
    if(/class="[^"]*\banm2player\b|<h1>Data:Anm2\/[^<]+\.json<\/h1>/.test(text))
      text=text.replace('</head>','<script src="/wiki-player.js" defer></script></head>');
    content(req,res,html,text);
  }
  const redirect=(res,to)=>{res.writeHead(302,{Location:to,'Cache-Control':'no-cache'});res.end();};
  const server=http.createServer(async(req,res)=>{
    try{
      const port=server.address()?.port;
      if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host))
        return content(req,res,'text/plain; charset=utf-8','只接受本机地址',403);
      if(req.method!=='GET'&&req.method!=='HEAD'){
        res.setHeader('Allow','GET, HEAD');
        return content(req,res,'text/plain; charset=utf-8','离线站仅供阅读',405);
      }
      const url=new URL(req.url,'http://127.0.0.1');
      const route=url.pathname;
      if(route==='/'||route==='/index.html')return await article(req,res,pages['首页']);
      if(['/wiki','/wiki/','/progress','/progress/','/dashboard.html'].includes(route))return redirect(res,'/');
      if(route.startsWith('/wiki/')){
        const title=decodeURIComponent(route.slice(6)).replace(/_/g,' ').trim().normalize('NFC');
        if(Object.hasOwn(pages,title)&&pageFilename.test(pages[title]))return redirect(res,'/pages/'+pages[title]);
        return content(req,res,html,'<!doctype html><meta charset="utf-8"><title>条目不在离线库</title><h1>'+escape(title)+'</h1><p>此条目不在离线库。</p><a href="/">返回首页</a> · <a href="'+original+'/wiki/'+encodeURIComponent(title)+'">联网查看原站</a>',404);
      }
      if(route==='/search'){
        const q=(url.searchParams.get('q')||'').slice(0,200),query=q.toLocaleLowerCase();
        const titles=Object.keys(pages).filter(t=>t.toLocaleLowerCase().includes(query)).sort((a,b)=>a.localeCompare(b,'zh-CN'));
        const results=titles.slice(0,1000).map(t=>'<li><a href="/wiki/'+encodeURIComponent(t)+'">'+escape(t)+'</a></li>').join('');
        return content(req,res,html,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>离线条目搜索</title><link rel="stylesheet" href="/offline.css"><body class="isaac-offline"><main class="offline-main"><a href="/">返回 Wiki 首页</a><h1>已下载条目搜索</h1><form action="/search"><input name="q" value="'+escape(q)+'" aria-label="关键词"><button>搜索</button></form><p>匹配 '+titles.length+' 个条目</p><ul>'+results+'</ul>'+(titles.length>1000?'<p>显示前 1000 个结果，请缩小关键词范围。</p>':'')+'</main></body></html>');
      }
      if(files.has(route))return await send(req,res,path.join(directory,route.slice(1)),files.get(route));
      const page=route.match(/^\/pages\/([a-f0-9]{64}\.html)$/);
      if(page)return await article(req,res,page[1]);
      const asset=route.match(/^\/assets\/([a-f0-9]{64}\.asset)$/);
      if(asset&&Object.hasOwn(assets,asset[1]))return await send(req,res,path.join(site,'assets',asset[1]),assets[asset[1]]);
      const compiled=route.match(/^\/compiled\/(index\.json|anm2\.js|rules\.js|actors\/[a-f0-9]{64}\.json)$/);
      if(compiled)return await send(req,res,path.join(site,'compiled',compiled[1]),compiled[1].endsWith('.js')?js:json);
      return content(req,res,'text/plain; charset=utf-8','文件不存在',404);
    }catch(error){
      if(!res.headersSent&&!res.destroyed)content(req,res,'text/plain; charset=utf-8',error.code==='ENOENT'?'文件不存在':'无法读取请求',error.code==='ENOENT'?404:400);
      else if(!res.writableEnded)res.destroy();
    }
  });
  return {server,pages:Object.keys(pages).length,assets:Object.keys(assets).length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server,pages,assets}=await createReader();
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口 8765 已被占用；请先关闭正在使用该端口的进程。':error.message);process.exitCode=1;});
  server.listen(8765,'127.0.0.1',()=>console.log('以撒离线 Wiki：http://127.0.0.1:8765/ · '+pages+' 个页面 / '+assets+' 项素材'));
}
