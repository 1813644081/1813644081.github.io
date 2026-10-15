'use strict';
const local = 'http://127.0.0.1:8765';
const hosts = new Set(['huiji-public.huijistatic.com','huiji-thumb.huijistatic.com','fs.huijiwiki.com','av.huijiwiki.com']);
async function config() { return (await fetch(chrome.runtime.getURL('config.json'))).json(); }
chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !tab.url?.startsWith('https://isaac.huijiwiki.com/')) {
    await chrome.action.setBadgeText({text:'WIKI'}); return;
  }
  try {
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['shared.js','content.js']});
    await chrome.action.setBadgeText({text:''});
  } catch (e) { console.error('无法打开导出面板', e.message); await chrome.action.setBadgeText({text:'ERR'}); }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab?.url?.startsWith('https://isaac.huijiwiki.com/')) return false;
  (async () => {
    if (message.kind === 'local') {
      if (!/^\/api\/[a-z-]+$/.test(message.path)) throw new Error('非法本地请求');
      const {token} = await config();
      const response = await fetch(local + message.path, {method:message.body === undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json','X-Mirror-Token':token},body:message.body === undefined ? undefined : JSON.stringify(message.body),signal:AbortSignal.timeout(90000)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `本地服务 HTTP ${response.status}`);
      return result;
    }
    if (message.kind === 'asset') {
      const url = new URL(message.url);
      if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('素材域名不在允许范围');
      const response = await fetch(url.href, {credentials:'omit',signal:AbortSignal.timeout(90000)});
      if (!response.ok) throw new Error(`素材 HTTP ${response.status}`);
      if (!hosts.has(new URL(response.url).hostname)) throw new Error('素材跳转到了未允许的域名');
      const mime = response.headers.get('content-type') || 'application/octet-stream';
      if (/text\/html/i.test(mime)) throw new Error('素材返回了 HTML 或验证页');
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 64 * 1024 * 1024) throw new Error('素材超过 64 MB，需要单独导出');
      let encoded = '';
      const bytes = new Uint8Array(buffer);
      for (let i=0; i<bytes.length; i+=16384) encoded += String.fromCharCode(...bytes.subarray(i,i+16384));
      return {base64:btoa(encoded),mime};
    }
    throw new Error('未知操作');
  })().then(data=>reply({ok:true,data}),e=>reply({ok:false,error:e.message}));
  return true;
});
