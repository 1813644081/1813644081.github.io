'use strict';
(() => {
  const actorRoot = '/compiled/actors/';
  const memo = new Map();
  let index;
  const fallback = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  const file = /^[0-9a-f]{64}\.(?:asset|json)$/;
  const has = (object, key) => Object.hasOwn(object, key);
  const normalize = title => title.replace(/_/g, ' ').trim().normalize('NFC');
  async function read(url) {
    const res = await fetch(url, {redirect:'error'});
    if (!res.ok) throw new Error('本地动画资源 HTTP ' + res.status);
    return res.json();
  }
  function actor(id) {
    if (typeof id !== 'string' || !id.startsWith('Data:Anm2/')) return Promise.resolve(null);
    const key = normalize(id);
    if (!has(index.actors, key)) {console.warn('未保存的动画数据：', id);return Promise.resolve(null);}
    const name = index.actors[key];
    if (!file.test(name) || !name.endsWith('.json')) return Promise.reject(new Error('无效的动画文件索引'));
    if (!memo.has(name)) {
      const request = read(actorRoot + name);
      memo.set(name, request);
      request.catch(() => memo.delete(name));
    }
    return memo.get(name).then(value => ({...structuredClone(value), _id:id}));
  }
  async function query(filter) {
    if (typeof filter?._id === 'string') {
      const result = await actor(filter._id);
      return {_embedded:result ? [result] : []};
    }
    if (Array.isArray(filter?.$or)) {
      if (filter.$or.length > 50) throw new Error('单次动画数据请求最多 50 项');
      return {_embedded:(await Promise.all(filter.$or.map(entry => actor(entry?._id)))).filter(Boolean)};
    }
    const sprites = filter?.$and?.find(entry => Array.isArray(entry.$or))?.$or ?? [];
    return {_embedded:sprites.flatMap(entry => {
      const name = entry.sprite_path;
      return typeof name === 'string' && has(index.costumes, name)
        ? [{sprite_path:name, characolors:index.costumes[name]}] : [];
    })};
  }
  function loadScript(src) {
    return new Promise((ok, bad) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = ok;
      script.onerror = bad;
      document.head.append(script);
    });
  }
  async function init() {
    const title = document.querySelector('main h1')?.textContent ?? '';
    const players = [...document.querySelectorAll('.anm2player')];
    if (!players.length && !/^Data:Anm2\/.+\.json$/.test(title)) return;
    index = await read('/compiled/index.json');
    // Skip a player with missing data instead of aborting the other players on the page.
    for (const container of players) {
      for (const part of [...container.children]) {
        const raw = part.getAttribute('data-anm2');
        if (raw === null) continue;
        const id = normalize('Data:' + raw.replace(/[&?]/g, ''));
        if (!has(index.actors, id)) part.removeAttribute('data-anm2');
      }
      if (![...container.children].some(part => part.hasAttribute('data-anm2'))) {
        container.classList.remove('anm2player');
        container.textContent = '这段动画的数据未保存在离线库中。';
      }
    }
    window.IsaacWikiPlayer = Object.freeze({
      sprite(name) {
        if (typeof name !== 'string' || !has(index.sprites, name)) return fallback;
        const filename = index.sprites[name];
        return file.test(filename) && filename.endsWith('.asset') ? '/assets/' + filename : fallback;
      },
      config(key) {return key === 'wgPageName' ? title.replace(/ /g,'_') : false;},
      ajax({url, method, data}) {
        const operation = Promise.resolve().then(() => {
          if (url !== '/api/rest_v1/namespace/data' || method !== 'GET') throw new Error('离线播放器只支持本地动画数据');
          return query(JSON.parse(data.filter));
        });
        let completed, failed;
        operation.then(value => completed?.(value), error => failed?.(null, error.message))
          .catch(error => console.error('离线动画回调失败：', error));
        const callbacks = {
          done(fn) {completed=fn;return callbacks;},
          fail(fn) {failed=fn;return callbacks;},
        };
        return callbacks;
      },
      notice({title,content}) {console.info(title, content);return {content};},
    });
    await loadScript('/compiled/rules.js');
    await loadScript('/compiled/anm2.js');
  }
  init().catch(error => {
    console.error('离线动画加载失败：', error);
    document.querySelectorAll('.anm2player').forEach(node => {
      if (!node.querySelector('canvas')) node.textContent = '离线动画未能加载。';
    });
  });
})();
