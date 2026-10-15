(function () {
  'use strict';
  if (document.getElementById('isaac-export-panel')) return;
  const host = document.createElement('div'); host.id = 'isaac-export-panel';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647';
  const panel = host.attachShadow({mode:'closed'});
  panel.innerHTML = `<style>:host{all:initial}section{width:360px;padding:22px;background:#172b39;color:#e9f1f3;border:1px solid #6e969f;border-radius:14px;box-shadow:0 12px 45px #0008;font:14px/1.65 system-ui}h2{margin:0 0 10px;font-size:19px}button{cursor:pointer;border:0;border-radius:7px;padding:10px 14px;margin:8px 8px 0 0;background:#9ee0c0;color:#132b26}button.secondary{background:#d0dce3}pre{white-space:pre-wrap;max-height:170px;overflow:auto;font:13px/1.5 system-ui}a{color:#9ee0c0}</style><section><h2>全站离线导出</h2><p>下载当前公开页面、分类及原始上传素材。请求逐个处理，可暂停和断点继续。请保持此 Wiki 标签页打开。</p><button id="test">检查连接</button><button id="run">开始 / 继续</button><button id="pause" class="secondary">暂停</button><pre id="status">本地服务：http://127.0.0.1:8765</pre><a href="http://127.0.0.1:8765/" target="_blank" rel="noopener noreferrer">查看本地下载进度</a></section>`;
  document.documentElement.append(host);
  const text = value => { panel.getElementById('status').textContent = value; };
  let running = false;
  async function message(data) {
    const response = await chrome.runtime.sendMessage(data);
    if (!response?.ok) throw new Error(response?.error || '扩展连接已断开，请重新加载后点击扩展');
    return response.data;
  }
  const local = (path,body) => message({kind:'local',path,body});
  async function remote(url, binary=false) {
    const u = IsaacMirror.absolute(url, IsaacMirror.ORIGIN);
    if (!u) throw new Error('请求地址未允许');
    if (u.origin !== location.origin) return message({kind:'asset',url:u.href});
    const response = await fetch(u.href, {credentials:'include',signal:AbortSignal.timeout(90000)});
    if (!response.ok) {
      const e = new Error(`原站 HTTP ${response.status}；如有验证，请在此标签页正常完成后继续`);
      e.blocked = [401,403,429].includes(response.status); throw e;
    }
    if (new URL(response.url).origin !== location.origin) throw new Error('原站发生跨域跳转');
    const mime = response.headers.get('content-type') || '';
    if (binary) {
      if (/text\/html/i.test(mime)) throw new Error('素材返回了 HTML');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 64*1024*1024) throw new Error('素材超过 64 MB');
      let raw=''; for(let i=0;i<bytes.length;i+=16384) raw+=String.fromCharCode(...bytes.subarray(i,i+16384));
      return {base64:btoa(raw),mime};
    }
    const value = await response.text();
    if (/Just a moment|cf_chl_opt|challenge-platform/.test(value)) {const e=new Error('原站返回验证页，已暂停。');e.blocked=true;throw e;}
    return value;
  }
  panel.getElementById('test').onclick = async () => {
    try {
      const state = await local('/api/status');
      const raw = await remote(IsaacMirror.ORIGIN+'/api.php?action=query&meta=siteinfo&siprop=statistics&format=json&formatversion=2');
      const result = JSON.parse(raw); if(result.error) throw new Error(result.error.info);
      text('本地服务正常；原站 API 正常。\n已下载页面：'+state.pages+'\n原站统计：'+JSON.stringify(result.query?.statistics));
    } catch(e) {text('连接检查失败：'+e.message);}
  };
  panel.getElementById('pause').onclick = async () => {
    running=false;
    try {await local('/api/control',{action:'pause'}); text('正在完成当前请求，然后暂停。已保存的内容会保留。');} catch(e){text(e.message);}
  };
  panel.getElementById('run').onclick = async () => {
    if(running)return;running=true;
    let current;
    try {
      await local('/api/control',{action:'start'});
      while(running) {
        const job = await local('/api/next');
        if(!job){const state=await local('/api/status');text('当前队列已处理。\n'+JSON.stringify(state,null,2));break;}
        current=job;text(`正在处理：${job.title || job.kind}\n${job.url || '已保存的首页'}`);
        try {
          let result;
          if(job.kind==='seed') {
            const seed=await local('/api/seed');result=await IsaacMirror.html(seed.source,'首页',IsaacMirror.ORIGIN+'/wiki/'+encodeURIComponent('首页'));
          } else if(job.kind==='page') {
            const source=await remote(job.url); result=await IsaacMirror.html(source,job.title,job.url);
          } else if(job.kind==='asset') {
            result=await remote(job.url,true);
            if (/text\/css/i.test(result.mime) || /\.css(?:\?|$)/i.test(job.url)) {
              const bytes=Uint8Array.from(atob(result.base64), c=>c.charCodeAt(0));
              const set=new Set();set.rejected=new Set();
              const converted=await IsaacMirror.css(new TextDecoder().decode(bytes),job.url,'',set);
              result={text:converted.text,mime:'text/css; charset=utf-8',assets:converted.assets,rejected:converted.rejected};
            }
          } else {
            const raw=await remote(job.url);result=JSON.parse(raw);
            if(result.error) {const e=new Error(result.error.info||result.error.code);e.blocked=result.error.code==='maxlag';throw e;}
          }
          await local('/api/result',{id:job.id,result});
        } catch(e) {
          await local('/api/failure',{id:job.id,error:e.message,blocked:!!e.blocked});
          if(e.blocked)throw e;
        }
        current=null;
        await new Promise(resolve=>setTimeout(resolve,800));
      }
    } catch(e) {text('已停止：'+e.message+'\n进度已保存。处理问题后点击“开始 / 继续”。');}
    finally {running=false;}
  };
})();
