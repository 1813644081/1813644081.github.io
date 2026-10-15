(function (root) {
  'use strict';
  const ORIGIN = 'https://isaac.huijiwiki.com';
  const hosts = new Set(['isaac.huijiwiki.com', 'huiji-public.huijistatic.com', 'huiji-thumb.huijistatic.com', 'fs.huijiwiki.com', 'av.huijiwiki.com']);
  const hashCache = new Map();
  const HASH_CACHE_LIMIT = 8192;
  const normalizeTitle = title => title.replace(/_/g, ' ').trim().normalize('NFC');
  const absolute = (value, base) => {
    try { const u = new URL(value, base); if (u.protocol !== 'https:' || !hosts.has(u.hostname) || u.port || u.username || u.password) return null; return u; } catch { return null; }
  };
  async function hash(value) {
    const cached = hashCache.get(value);
    if (cached) {
      hashCache.delete(value); hashCache.set(value, cached);
      return cached;
    }
    // Shared page styles and sprites reuse their digest, including in-flight requests.
    if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.delete(hashCache.keys().next().value);
    const pending = Promise.resolve()
      .then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
      .then(bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''));
    hashCache.set(value, pending);
    pending.catch(() => { if (hashCache.get(value) === pending) hashCache.delete(value); });
    return pending;
  }
  async function asset(value, base, relative, assets) {
    if (!value || /^(data:|#)/i.test(value)) return value;
    const u = absolute(value, base);
    if (!u) { assets.rejected?.add(String(value)); return ''; }
    const fragment = u.hash; u.hash = '';
    const url = u.href;
    assets.add(url);
    return relative + await hash(url) + '.asset' + fragment;
  }
  async function replaceAsync(text, pattern, fn) {
    const matches = [...text.matchAll(pattern)];
    const replacements = await Promise.all(matches.map(fn));
    let end = 0, out = '';
    matches.forEach((m, i) => { out += text.slice(end, m.index) + replacements[i]; end = m.index + m[0].length; });
    return out + text.slice(end);
  }
  async function css(text, base, relative = '', assets = new Set()) {
    // CSS downloads are rewritten before saving; nested fonts, sprites and imports join the queue.
    text = await replaceAsync(text, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi,
      async m => `url("${await asset(m[1] ?? m[2] ?? m[3], base, relative, assets)}")`);
    text = await replaceAsync(text, /@import\s+(?:"([^"]*)"|'([^']*)')/gi,
      async m => `@import "${await asset(m[1] ?? m[2], base, relative, assets)}"`);
    return {text, assets: [...assets], rejected: [...(assets.rejected || [])]};
  }
  function titleFromLink(value, base = ORIGIN + '/wiki/首页') {
    try {
      const u = new URL(value, base);
      if (u.origin !== ORIGIN) return null;
      let title;
      if (u.pathname.startsWith('/wiki/')) title = decodeURIComponent(u.pathname.slice(6));
      else if (/^\/(w\/)?index\.php$/.test(u.pathname) && (!u.searchParams.has('action') || u.searchParams.get('action') === 'view')) title = u.searchParams.get('title');
      if (!title || u.searchParams.has('diff') || u.searchParams.has('oldid')) return null;
      return {title: normalizeTitle(title), fragment:u.hash};
    } catch { return null; }
  }
  const escape = str => String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function html(source, title, sourceURL, fallbackText) {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const content = doc.querySelector('#mw-content-text');
    if (!content && fallbackText === undefined) throw new Error('未找到文章正文，可能是验证页；未保存为条目。');
    const body = content || doc.createElement('pre');
    if (!content) body.textContent = fallbackText;
    const assets = new Set(); assets.rejected = new Set();
    const styles = [];
    for (const node of doc.querySelectorAll('link[rel="stylesheet"][href]')) {
      const href = await asset(node.getAttribute('href'), sourceURL, '../assets/', assets);
      if (href) styles.push(`<link rel="stylesheet" href="${escape(href)}">`);
    }
    for (const node of doc.querySelectorAll('head style')) {
      const result = await css(node.textContent, sourceURL, '../assets/', assets);
      styles.push(`<style>${result.text.replace(/<\/style/gi, '')}</style>`);
    }
    body.querySelectorAll('script,iframe,object,embed,base,form,meta,link,foreignObject,animate,set,animateTransform,animateMotion').forEach(n => n.remove());
    for (const node of body.querySelectorAll('style')) node.textContent = (await css(node.textContent, sourceURL, '../assets/', assets)).text;
    for (const node of [body, ...body.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name) || /^(srcdoc|ping|nonce)$/i.test(attr.name)) node.removeAttribute(attr.name);
      }
      if (node.hasAttribute('style')) node.setAttribute('style', (await css(node.getAttribute('style'), sourceURL, '../assets/', assets)).text);
      if (node.hasAttribute('srcset')) {
        // Keep the displayed image at its original size; download every responsive candidate too.
        const set = node.getAttribute('srcset');
        if (!/^data:/i.test(set)) {
          const result = [];
          for (const candidate of set.split(',')) {
            const parts = candidate.trim().split(/\s+/);
            const target = await asset(parts.shift(), sourceURL, '../assets/', assets);
            if (target) result.push([target, ...parts].join(' '));
          }
          node.setAttribute('srcset', result.join(', '));
        }
      }
      for (const attr of ['src','poster','data-src']) if (node.hasAttribute(attr)) {
        const target = await asset(node.getAttribute(attr), sourceURL, '../assets/', assets);
        if (target) node.setAttribute(attr === 'data-src' ? 'src' : attr, target); else node.removeAttribute(attr);
      }
      if (node.tagName.toLowerCase() === 'a' && node.hasAttribute('href')) {
        const href = node.getAttribute('href');
        if (href.startsWith('#')) continue;
        const link = titleFromLink(href, sourceURL);
        if (link) node.setAttribute('href', '../wiki/' + encodeURIComponent(link.title) + link.fragment);
        else {
          try {
            const u = new URL(href, sourceURL);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') node.removeAttribute('href');
            else if (hosts.has(u.hostname) && u.hostname !== 'isaac.huijiwiki.com') node.setAttribute('href', await asset(href, sourceURL, '../assets/', assets));
            else { node.setAttribute('href', u.href); node.setAttribute('rel', 'noopener noreferrer'); node.setAttribute('target', '_blank'); node.setAttribute('title', '原站或外部链接，需要联网'); }
          } catch { node.removeAttribute('href'); }
        }
      } else for (const attr of ['href','xlink:href']) if (node.hasAttribute(attr)) {
        const href = node.getAttribute(attr);
        if (!href.startsWith('#')) { const target = await asset(href, sourceURL, '../assets/', assets); if (target) node.setAttribute(attr, target); else node.removeAttribute(attr); }
      }
      node.removeAttribute('data-src');
    }
    const savedTime = new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) + '（北京时间）';
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · 以撒离线 Wiki</title>${styles.join('\n')}<link rel="stylesheet" href="../offline.css"><script src="../offline.js" defer></script></head><body class="isaac-offline"><header class="offline-header"><a href="../wiki/${encodeURIComponent('首页')}">以撒离线 Wiki</a><form action="../search"><input name="q" aria-label="搜索已下载条目" placeholder="搜索已下载条目"><button>搜索</button></form><a href="../">下载进度</a></header><main class="offline-main mw-body"><h1>${escape(title)}</h1>${body.outerHTML}</main><footer class="offline-footer">来源：<a href="${escape(sourceURL)}" rel="noopener noreferrer" target="_blank">以撒的结合中文维基 / ${escape(title)}</a> · 保存时间 ${savedTime}<br>内容及素材保留原作者署名与原站许可，详见 <a href="../wiki/${encodeURIComponent('著作权')}">著作权</a>。动画播放器、登录、编辑及其他服务器功能未包含在静态版中。</footer></body></html>`;
    return {html:page, assets:[...assets], rejected:[...assets.rejected]};
  }
  const api = {ORIGIN,hosts,normalizeTitle,absolute,hash,asset,css,titleFromLink,escape,html};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IsaacMirror = api;
})(globalThis);
