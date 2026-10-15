(function () {
  'use strict';
  function retryAfter(response) {
    const value = response.headers?.get('Retry-After');
    if (!value) return 0;
    const seconds = Number(value);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(wait) ? Math.min(2147483647, Math.max(0, Math.ceil(wait))) : 0;
  }
  async function request(url) {
    if (!IsaacMirror.absolute(url, IsaacMirror.ORIGIN) || new URL(url).origin !== IsaacMirror.ORIGIN) throw new Error('原站请求地址无效');
    const response = await fetch(url, {credentials:'include',signal:AbortSignal.timeout(90000)});
    if (!response.ok) {
      const code = response.status;
      const reason = [401,403].includes(code) ? '请在程序的“原站验证”页正常完成验证后继续。'
        : code === 429 ? '原站请求限流，请等待后继续下载。'
        : code >= 500 && code <= 599 ? '原站服务器错误，请稍后重试此页面。'
        : '原站请求失败，请稍后重试此任务。';
      const error = new Error('原站 HTTP ' + code + '；' + reason);
      error.statusCode = code; error.retryAfterMs = retryAfter(response);
      error.blocked = [401,403,429].includes(response.status); throw error;
    }
    if (new URL(response.url).origin !== IsaacMirror.ORIGIN) throw new Error('原站发生跨域跳转');
    const text = await response.text();
    if (/cf_chl_opt|challenge-platform|Just a moment/.test(text)) {const error=new Error('原站需要验证；下载已暂停。');error.blocked=true;error.statusCode=response.status;throw error;}
    return text;
  }
  async function execute(job, extra) {
    if (location.origin !== IsaacMirror.ORIGIN) throw new Error('请先连接原站并完成验证。');
    if (job.kind === 'seed') return IsaacMirror.html(extra.source, '首页', IsaacMirror.ORIGIN+'/wiki/'+encodeURIComponent('首页'));
    if (job.kind === 'page') return IsaacMirror.html(await request(job.url), job.title, job.url);
    if (job.kind === 'check') {
      const result = JSON.parse(await request(IsaacMirror.ORIGIN+'/api.php?action=query&meta=siteinfo&siprop=statistics&format=json&formatversion=2'));
      if(result.error)throw new Error(result.error.info||result.error.code);
      return result;
    }
    if (job.kind === 'asset') {
      if (/text\/css/i.test(extra.mime) || /\.css(?:\?|$)/i.test(job.url)) {
        const bytes=Uint8Array.from(atob(extra.base64),c=>c.charCodeAt(0));
        const assets=new Set();assets.rejected=new Set();
        const result=await IsaacMirror.css(new TextDecoder().decode(bytes),job.url,'',assets);
        return {text:result.text,mime:'text/css; charset=utf-8',assets:result.assets,rejected:result.rejected};
      }
      return extra;
    }
    const result=JSON.parse(await request(job.url));
    if(result.error){const error=new Error(result.error.info||result.error.code);error.blocked=result.error.code==='maxlag';throw error;}
    return result;
  }
  window.IsaacDesktopRun = function (id, job, extra) {
    execute(job,extra||{}).then(result=>chrome.webview.postMessage({channel:'isaac-desktop',id,ok:true,result}),
      error=>chrome.webview.postMessage({channel:'isaac-desktop',id,ok:false,error:error.message,blocked:!!error.blocked,statusCode:error.statusCode||0,retryAfterMs:error.retryAfterMs||0}));
  };
})();
