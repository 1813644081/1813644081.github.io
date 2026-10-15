import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createMirror} from './server.mjs';
import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url),M=require('./shared.js');

async function fixtureMirror(jobs,extra={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isaac-index-test-'));
  await fs.mkdir(path.join(dir,'data'));
  await fs.writeFile(path.join(dir,'data/state.json'),JSON.stringify({version:1,_seq:1,running:false,started:null,namespaces:[{id:0,name:''}],jobs,pages:{},assets:{},rejected:{},lastError:null,...extra}));
  return createMirror(dir);
}
const fixtureJob=(id,kind,title=id)=>({id,kind,title,url:M.ORIGIN+'/index.php?'+new URLSearchParams({title}),status:'pending',attempts:0});

test('article URLs preserve Chinese titles, normalize underscores and exclude editing/history',()=>{
  assert.deepEqual(M.titleFromLink('/wiki/%E4%BB%A5%E6%92%92#测试'),{title:'以撒',fragment:'#%E6%B5%8B%E8%AF%95'});
  assert.equal(M.titleFromLink('/index.php?title=A_B').title,'A B');
  assert.equal(M.titleFromLink('/index.php?title=A&action=edit'),null);
  assert.equal(M.titleFromLink('/wiki/A?oldid=12'),null);
  assert.equal(M.titleFromLink('https://example.org/wiki/A'),null);
  assert.equal(M.absolute('https://isaac.huijiwiki.com.evil.example/a',M.ORIGIN),null);
});

test('CSS imports, sprites, font files and fragments become deterministic local resources',async()=>{
  const urls=new Set();urls.rejected=new Set();
  const result=await M.css('@import "base.css";a{background:url(../sprites.png);src:url("font.woff2#x")}b{background:url(data:image/png;base64,AA)}', 'https://fs.huijiwiki.com/css/main.css','',urls);
  assert.equal(result.assets.length,3);
  assert.ok(result.assets.includes('https://fs.huijiwiki.com/sprites.png'));
  assert.match(result.text,/[a-f0-9]{64}\.asset#x/);
  assert.match(result.text,/data:image\/png;base64,AA/);
  assert.doesNotMatch(result.text,/url\("https:/);
  const rejected=await M.css('a{background:url(https://evil.example/p.png)}','https://fs.huijiwiki.com/x.css','',urls);
  assert.ok(rejected.rejected.includes('https://evil.example/p.png'));
});

test('enumeration continues through namespaces and pagination; failures never report completion; state resumes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isaac-mirror-test-'));
  const mirror=await createMirror(dir);
  await mirror.control('start');
  let job=await mirror.next();assert.equal(job.kind,'seed');
  await mirror.accept(job.id,{html:'<!doctype html><title>首页</title>',assets:[]});
  job=await mirror.next();assert.equal(job.kind,'siteinfo');
  await mirror.accept(job.id,{query:{general:{},namespaces:{0:{id:0,name:''},14:{id:14,name:'分类'},'-1':{id:-1,name:'特殊'}}}});
  job=await mirror.next();assert.equal(job.kind,'allpages');
  await mirror.accept(job.id,{query:{allpages:[{title:'以撒',pageid:1,ns:0}]},continue:{apcontinue:'第二页',continue:'-||'}});
  job=await mirror.next();assert.equal(job.ns,14);
  await mirror.accept(job.id,{query:{allpages:[]}});
  job=await mirror.next();assert.equal(job.kind,'allimages');
  await mirror.accept(job.id,{query:{allimages:[{url:'https://huiji-public.huijistatic.com/isaac/x.png'}]}});
  job=await mirror.next();assert.equal(job.kind,'allpages');assert.ok(job.url.includes('apcontinue='));
  await mirror.accept(job.id,{query:{allpages:[]}});
  job=await mirror.next();assert.equal(job.kind,'page');
  await mirror.accept(job.id,{html:'<!doctype html><title>以撒</title>',assets:[]});
  job=await mirror.next();assert.equal(job.kind,'asset');
  await mirror.failure(job.id,'HTTP 403',true);
  assert.equal(mirror.stats().running,false);assert.equal(mirror.stats().complete,false);
  await mirror.control('start');job=await mirror.next();
  await mirror.accept(job.id,{base64:Buffer.from('png-test').toString('base64'),mime:'image/png'});
  assert.equal(mirror.stats().complete,true);assert.equal(mirror.stats().pages,2);
  const resumed=await createMirror(dir);assert.equal(resumed.stats().complete,true);assert.equal(resumed.state.running,false);
  // Fixtures are kept in the OS temporary directory; no recursive delete is needed.
});

test('local write endpoints require pairing and reject unrelated web origins',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'isaac-mirror-http-'));
  const mirror=await createMirror(dir);
  await new Promise(resolve=>mirror.server.listen(0,'127.0.0.1',resolve));
  try {
    const port=mirror.server.address().port;
    const request=(headers={})=>fetch(`http://127.0.0.1:${port}/api/control`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action:'start'})});
    assert.equal((await request()).status,403);
    assert.equal((await request({'X-Mirror-Token':mirror.token,Origin:'https://evil.example'})).status,403);
    assert.equal((await request({'X-Mirror-Token':mirror.token,Origin:'chrome-extension://'+'a'.repeat(32)})).status,200);
    const traversal=await fetch(`http://127.0.0.1:${port}/%2e%2e/.mirror-token`);
    assert.equal(traversal.status,404);
  } finally {await new Promise(resolve=>mirror.server.close(resolve));}
});

test('channel queues preserve stable priority and retry order, and assets wait for all active pages',async()=>{
  const mirror=await fixtureMirror({p1:fixtureJob('p1','page'),a1:{...fixtureJob('a1','asset'),url:M.ORIGIN+'/x.png'},p2:fixtureJob('p2','page')});
  // Starting through this fixture directly avoids adding new seed / siteinfo tasks.
  mirror.state.running=true;
  assert.equal(await mirror.next('asset'),null);
  let job=await mirror.next('page-or-meta');assert.equal(job.id,'p1');
  await mirror.failure(job.id,'HTTP 500',false);
  job=await mirror.next('page-or-meta');assert.equal(job.id,'p1');
  await mirror.failure(job.id,'HTTP 500',false);
  job=await mirror.next('page-or-meta');assert.equal(job.id,'p1');
  await mirror.failure(job.id,'HTTP 500',false);
  assert.equal(mirror.stats().failed,1);assert.equal(mirror.stats().pendingPages,1);
  job=await mirror.next('page-or-meta');assert.equal(job.id,'p2');
  assert.equal(mirror.stats().activePages,1);assert.equal(await mirror.next('asset'),null);
  await mirror.accept(job.id,{html:'<!doctype html><title>p2</title>',assets:[]});
  assert.equal(await mirror.next('page-or-meta'),null);
  job=await mirror.next('asset');assert.equal(job.id,'a1');assert.equal(mirror.stats().activeAssets,1);
  await mirror.accept(job.id,{base64:Buffer.from('image').toString('base64'),mime:'image/png'});
  assert.equal(mirror.stats().assets,1);assert.equal(mirror.stats().bytes,5);assert.equal(mirror.stats().complete,false);
});

test('expired leases requeue through the index and restart preserves pending jobs',async()=>{
  const mirror=await fixtureMirror({p1:fixtureJob('p1','page'),p2:fixtureJob('p2','page')});
  mirror.state.running=true;
  let job=await mirror.next('page-or-meta');assert.equal(job.id,'p1');
  mirror.state.jobs.p1.leaseUntil=Date.now()-1;
  job=await mirror.next('page-or-meta');assert.equal(job.id,'p1');assert.equal(job.attempts,2);
  assert.equal(mirror.stats().pendingPages,1);assert.equal(mirror.stats().activePages,1);
  await mirror.control('checkpoint');
  const resumed=await createMirror(mirror.directory);
  assert.equal(resumed.stats().active,0);assert.equal(resumed.stats().pendingPages,2);assert.equal(resumed.state.jobs.p1.attempts,2);
  resumed.state.running=true;assert.equal((await resumed.next()).id,'p1');
});

test('checkpoints serialize concurrent saves, compact the journal and resume exact progress',async()=>{
  const mirror=await fixtureMirror({p1:fixtureJob('p1','page'),p2:fixtureJob('p2','page')},{siteinfo:{general:{sitename:'static meta'},namespaces:{0:{id:0}}}});
  mirror.state.running=true;
  const [first,second]=await Promise.all([mirror.next('page-or-meta'),mirror.next('page-or-meta')]);
  assert.notEqual(first.id,second.id);assert.equal(mirror.stats().activePages,2);
  await Promise.all([mirror.control('checkpoint'),mirror.accept(first.id,{html:'<!doctype html><title>first</title>',assets:[]}),mirror.accept(second.id,{html:'<!doctype html><title>second</title>',assets:[]})]);
  const journal=await fs.readFile(path.join(mirror.directory,'data/progress.jsonl'),'utf8');
  assert.doesNotMatch(journal,/static meta/);
  const resumed=await createMirror(mirror.directory);assert.equal(resumed.stats().pages,2);assert.equal(resumed.stats().complete,true);
  await resumed.control('checkpoint');assert.equal(await fs.readFile(path.join(mirror.directory,'data/progress.jsonl'),'utf8'),'');
  const final=await createMirror(mirror.directory);assert.equal(final.stats().pages,2);assert.equal(final.stats().complete,true);
});

test('stream replay tolerates only an interrupted final record and supports old full metadata patches',async()=>{
  const mirror=await fixtureMirror({p1:fixtureJob('p1','page')});
  const journal=path.join(mirror.directory,'data/progress.jsonl');
  await fs.writeFile(journal,JSON.stringify({seq:2,meta:{running:true,siteinfo:{general:{sitename:'legacy'}}},jobs:{p1:{...fixtureJob('p1','page'),status:'failed',attempts:3}},pages:{},assets:{},rejected:{}})+'\n{"seq":3,');
  const resumed=await createMirror(mirror.directory);assert.equal(resumed.stats().failed,1);assert.equal(resumed.state.siteinfo.general.sitename,'legacy');assert.equal(resumed.state._seq,2);
  await resumed.control('retry');
  const repaired=await createMirror(mirror.directory);assert.equal(repaired.stats().pendingPages,1);assert.equal(repaired.state._seq,3);
  await fs.writeFile(journal,'not-json\n'+JSON.stringify({seq:3,meta:{},jobs:{},pages:{},assets:{},rejected:{}})+'\n');
  await assert.rejects(createMirror(mirror.directory),SyntaxError);
});

test('HTTP channel and shutdown endpoints expose identity, save progress, and close without exiting the test process',async()=>{
  const mirror=await fixtureMirror({p1:fixtureJob('p1','page'),a1:{...fixtureJob('a1','asset'),url:M.ORIGIN+'/x.png'}});mirror.state.running=true;
  await new Promise(resolve=>mirror.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${mirror.server.address().port}`,headers={'X-Mirror-Token':mirror.token,'Content-Type':'application/json'};
  const status=await (await fetch(origin+'/api/status',{headers})).json();assert.equal(status.engineVersion,'2.0.0');assert.equal(status.dataDirectory,path.resolve(mirror.directory));
  assert.equal(await (await fetch(origin+'/api/next?kind=asset',{headers})).json(),null);
  const job=await (await fetch(origin+'/api/next?kind=page-or-meta',{headers})).json();assert.equal(job.id,'p1');
  const stopped=new Promise(resolve=>mirror.server.once('mirror-shutdown',resolve));
  const response=await fetch(origin+'/api/control',{method:'POST',headers,body:JSON.stringify({action:'shutdown'})});assert.equal(response.status,200);assert.equal((await response.json()).shuttingDown,true);
  await stopped;assert.equal(mirror.server.listening,false);
  const resumed=await createMirror(mirror.directory);assert.equal(resumed.stats().running,false);assert.equal(resumed.stats().pendingPages,1);assert.equal(resumed.stats().pendingAssets,1);
});

test('100,000 jobs use indexed stats and selection without rescanning the manifest',async t=>{
  const jobs={};for(let i=0;i<100000;i++){const id='p'+i;jobs[id]=fixtureJob(id,'page');}
  const mirror=await fixtureMirror(jobs);mirror.state.running=true;
  mirror.state.jobs=new Proxy(mirror.state.jobs,{ownKeys(){throw new Error('Unexpected full job scan');}});
  const started=performance.now();for(let i=0;i<10000;i++)assert.equal(mirror.stats().totalJobs,100000);
  const statsMs=performance.now()-started,nextStarted=performance.now();const job=await mirror.next();
  assert.equal(job.id,'p0');assert.equal(mirror.stats().pendingPages,99999);assert.equal(mirror.stats().activePages,1);
  t.diagnostic(`100,000 tasks: 10,000 status reads ${(statsMs).toFixed(1)} ms; indexed next with durable save ${(performance.now()-nextStarted).toFixed(1)} ms`);
});
