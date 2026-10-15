const priority={seed:0,siteinfo:1,allpages:2,allimages:2,page:3,asset:4};
const enumeration=new Set(['siteinfo','allpages','allimages']);

class Heap {
  values=[];
  push(value){
    const values=this.values;let i=values.length;values.push(value);
    while(i>0){const parent=(i-1)>>1;if(values[parent].order<=value.order)break;values[i]=values[parent];i=parent;}values[i]=value;
  }
  pop(){
    const values=this.values;if(!values.length)return null;
    const first=values[0],last=values.pop();if(!values.length)return first;
    let i=0;
    while(i*2+1<values.length){let child=i*2+1;if(child+1<values.length&&values[child+1].order<values[child].order)child++;if(values[child].order>=last.order)break;values[i]=values[child];i=child;}
    values[i]=last;return first;
  }
}

// Order numbers preserve the old stable priority sort, including failed retries.
export class JobIndex {
  constructor(jobs){
    this.jobs=jobs;this.heaps=Array.from({length:5},()=>new Heap());this.orders=new Map();this.scheduled=new Map();this.leased=new Map();
    this.generation=0;this.total=0;this.enumerationRemaining=0;this.status={};this.pages={};this.assets={};
    for(const [id,job]of Object.entries(jobs))this.register(id,job);
  }
  count(job,status,delta){
    this.status[status]=(this.status[status]||0)+delta;
    const counts=job.kind==='asset'?this.assets:this.pages;counts[status]=(counts[status]||0)+delta;
    if(enumeration.has(job.kind)&&status!=='done')this.enumerationRemaining+=delta;
  }
  enqueue(id,job){
    const generation=++this.generation;this.scheduled.set(id,generation);
    this.heaps[priority[job.kind]??3].push({id,order:this.orders.get(id),generation});
  }
  register(id,job){
    if(this.orders.has(id))throw new Error('任务索引不允许覆盖已有任务');
    this.orders.set(id,this.total++);this.count(job,job.status,1);
    if(job.status==='pending')this.enqueue(id,job);
    if(job.status==='leased')this.leased.set(id,job);
  }
  changed(id,job,previous,status){
    if(previous===status)return;
    this.count(job,previous,-1);this.count(job,status,1);this.scheduled.delete(id);this.leased.delete(id);
    if(status==='pending')this.enqueue(id,job);
    if(status==='leased')this.leased.set(id,this.jobs[id]);
  }
  take(kind){
    if(kind&&kind!=='page-or-meta'&&kind!=='asset')throw new Error('下载通道无效');
    const pageWork=(this.pages.pending||0)+(this.pages.leased||0);
    if(kind==='asset'&&pageWork)return null;
    const begin=kind==='asset'?4:0,end=kind==='page-or-meta'?4:5;
    for(let p=begin;p<end;p++){
      if(p===4&&pageWork)return null;
      let entry;
      while((entry=this.heaps[p].pop())){
        const job=this.jobs[entry.id];
        if(job?.status!=='pending'||this.scheduled.get(entry.id)!==entry.generation)continue;
        this.scheduled.delete(entry.id);return job;
      }
    }
    return null;
  }
  expire(now){for(const job of this.leased.values())if(job.leaseUntil<now)job.status='pending';}
}
