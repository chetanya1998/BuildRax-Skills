(()=>{
'use strict';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};

/* theme + nav */
$('#theme').onclick=()=>{const r=document.documentElement,t=r.dataset.theme==='dark'?'light':'dark';r.dataset.theme=t;store.set('bx-theme',t)};
$('#burger').onclick=e=>{const o=$('#links').classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',o)};
$$('#links a').forEach(a=>a.addEventListener('click',()=>$('#links').classList.remove('open')));

/* reveal + active nav + one-shot triggers */
const once=new Map();
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');const f=once.get(e.target);if(f){f();once.delete(e.target)}io.unobserve(e.target)}}),{threshold:.18});
$$('.rv').forEach(el=>io.observe(el));
const secs=$$('main section[id]'),links=$$('#links a[href^="#"]');
const so=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)links.forEach(a=>a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id))}),{rootMargin:'-45% 0px -50% 0px'});
secs.forEach(s=>so.observe(s));
const onView=(el,fn)=>{if(!el)return;once.set(el,fn);io.observe(el)};

/* hero canvas: drifting dependency graph with one red cycle */
(()=>{
 const c=$('#bg'),x=c.getContext('2d');let W,H,nodes=[],mx=-999,my=-999,raf;
 const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
 function size(){const r=c.parentElement.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);W=r.width;H=r.height;c.width=W*d;c.height=H*d;x.setTransform(d,0,0,d,0,0);
  const n=Math.round(Math.min(46,W/17));nodes=Array.from({length:n},(_,i)=>({x:Math.random()*W,y:Math.random()*H*.9,vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25,r:2+Math.random()*4,h:i%7===0}))}
 function frame(t){x.clearRect(0,0,W,H);const b=css('--blue'),o=css('--org'),red=css('--red');
  nodes.forEach(n=>{if(!reduce){n.x+=n.vx;n.y+=n.vy}if(n.x<0||n.x>W)n.vx*=-1;if(n.y<0||n.y>H)n.vy*=-1});
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i],q=nodes[j],d=Math.hypot(a.x-q.x,a.y-q.y);
   if(d<190){const near=Math.hypot((a.x+q.x)/2-mx,(a.y+q.y)/2-my)<140;x.strokeStyle=near?o:b;x.globalAlpha=(1-d/190)*(near?.7:.22);x.lineWidth=near?1.6:1;x.beginPath();x.moveTo(a.x,a.y);x.lineTo(q.x,q.y);x.stroke()}}
  nodes.forEach((n,i)=>{const p=n.h?1+.25*Math.sin(t/500+i):1,g=x.createRadialGradient(n.x,n.y,0,n.x,n.y,n.r*4*p);const col=n.h?red:b;g.addColorStop(0,col);g.addColorStop(1,'transparent');x.globalAlpha=n.h?.5:.35;x.fillStyle=g;x.beginPath();x.arc(n.x,n.y,n.r*4*p,0,7);x.fill();x.globalAlpha=.9;x.fillStyle=col;x.beginPath();x.arc(n.x,n.y,n.r,0,7);x.fill()});
  x.globalAlpha=1;if(!reduce)raf=requestAnimationFrame(frame)}
 size();addEventListener('resize',()=>{cancelAnimationFrame(raf);size();raf=requestAnimationFrame(frame)});
 c.parentElement.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top});
 document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(raf);if(!document.hidden)raf=requestAnimationFrame(frame)});
 raf=requestAnimationFrame(frame);
 const tl=$('#tilt');if(!reduce&&matchMedia('(hover:hover)').matches){tl.parentElement.addEventListener('pointermove',e=>{const r=tl.getBoundingClientRect();tl.style.setProperty('--ry',((e.clientX-r.left)/r.width-.5)*6+'deg');tl.style.setProperty('--rx',(.5-(e.clientY-r.top)/r.height)*5+'deg')});tl.addEventListener('pointerleave',()=>{tl.style.setProperty('--rx','0deg');tl.style.setProperty('--ry','0deg')})}
})();

/* flip cards: tap to toggle on touch */
$$('.flip').forEach(f=>f.addEventListener('click',()=>f.classList.toggle('on')));

/* interactive explorer (real edges from a scan of fixtures/sample-monorepo) */
(()=>{
 const N={
  server:{x:320,y:42,t:'server.ts',s:'api',p:'packages/api/src/server.ts'},
  routes:{x:200,y:150,t:'orders.ts',s:'routes',p:'packages/api/src/routes/orders.ts'},
  sord:{x:150,y:290,t:'orders.ts',s:'services',p:'packages/api/src/services/orders.ts'},
  bill:{x:420,y:290,t:'billing.ts',s:'services',p:'packages/api/src/services/billing.ts'},
  stripe:{x:560,y:385,t:'stripe',s:'external',p:'stripe'},
  express:{x:540,y:42,t:'express',s:'external',p:'express'},
  shared:{x:560,y:150,t:'packages/shared',s:'workspace',p:'packages/shared'},
  miss:{x:80,y:42,t:'./missing.js',s:'unresolved',p:'./missing.js'}};
 const E=[['server','routes',4],['server','express',1],['server','shared',3],['server','miss',5],['routes','bill',2],['routes','sord',1],['bill','sord',1,'cy'],['sord','bill',1,'cy'],['bill','stripe',2]];
 const svg=$('#xg'),NS='http://www.w3.org/2000/svg';let dir='up',sel=null;
 const el=(n,a,p)=>{const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);(p||svg).appendChild(e);return e};
 el('defs',{}).innerHTML='<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor" style="color:var(--mut)"/></marker>';
 const eEls=E.map(([a,b,l,cy],i)=>{const A=N[a],B=N[b];let d;
  if(cy){const sgn=a==='bill'?-1:1;d=`M${A.x} ${A.y+(a==='bill'?-20:20)} Q${(A.x+B.x)/2} ${(A.y+B.y)/2+sgn*(a==='bill'?-34:34)} ${B.x+(a==='bill'?65:-70)} ${B.y+(a==='bill'?-8:8)}`;
   d=a==='bill'?`M${A.x-70} ${A.y-8} Q${(A.x+B.x)/2} ${A.y-46} ${B.x+70} ${B.y-8}`:`M${A.x+70} ${A.y+8} Q${(A.x+B.x)/2} ${A.y+46} ${B.x-70} ${B.y+8}`}
  else{const dx=B.x-A.x,dy=B.y-A.y,k=Math.min(Math.abs(26/(dy||1)),1.2),sy=dy>0?20:-20;d=`M${A.x} ${A.y+sy} L${B.x} ${B.y-sy}`}
  const p=el('path',{d,class:'e'+(cy?' cy':''),'marker-end':'url(#ar)'});if(b==='miss')p.setAttribute('stroke-dasharray','3 5');return p});
 const nEls={};for(const k in N){const n=N[k],g=el('g',{class:'n',tabindex:0,role:'button','aria-label':'Select '+n.p,transform:`translate(${n.x},${n.y})`});
  el('rect',{x:-70,y:-22,width:140,height:44,rx:10},g);el('text',{y:-2,'text-anchor':'middle'},g).textContent=n.t;el('text',{y:13,'text-anchor':'middle',class:'s'},g).textContent=n.s;
  g.onclick=()=>pick(k);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(k)}};nEls[k]=g}
 function walk(start,d){const seen={[start]:0},out=[],q=[start];while(q.length){const c=q.shift();E.forEach(([a,b,l],i)=>{const from=d==='up'?b:a,to=d==='up'?a:b;if(from===c&&!(to in seen)){seen[to]=seen[c]+1;out.push({k:to,hop:seen[to],l,via:from,i});q.push(to)}})}return{seen,out}}
 function pick(k){sel=k;render()}
 function render(){const L=$('#iList');L.innerHTML='';
  Object.values(nEls).forEach(g=>g.setAttribute('class','n'));eEls.forEach((p,i)=>p.setAttribute('class','e'+(E[i][3]?' cy':'')));
  if(!sel){$('#iName').textContent='Select a file';$('#iNote').textContent='Click any box in the graph.';$('#iCmd').textContent='buildrax trace <file> --direction up';return}
  const {seen,out}=walk(sel,dir);Object.entries(nEls).forEach(([k,g])=>g.classList.add(k===sel?'sel':k in seen?(dir==='up'?'up':'dn'):'dim'));
  const hit=new Set(out.map(o=>o.i));E.forEach(([a,b],i)=>{const inSet=(dir==='up'?(b in seen&&a in seen):(a in seen&&b in seen));const p=eEls[i];if(inSet&&(hit.has(i)||(a in seen&&b in seen)))p.classList.add(dir==='up'?'up':'dn');else p.classList.add('dim')});
  const n=N[sel];$('#iName').textContent=n.p;
  $('#iNote').textContent=out.length?(dir==='up'?`${out.length} node(s) could break if this changes:`:`${out.length} node(s) it relies on:`):(dir==='up'?'Nothing depends on this file.':'No further dependencies.');
  out.forEach(o=>{const li=document.createElement('li');const e=E[o.i],cyc=e[3];li.className=cyc?'c':dir==='up'?'u':'d';li.style.animationDelay=o.hop*90+'ms';li.style.marginLeft=(o.hop-1)*14+'px';
   li.innerHTML=esc(N[o.k].p)+' <span style="color:var(--mut)">:'+(o.l)+'</span>'+(cyc?' <b style="color:var(--red)">circular</b>':'');L.appendChild(li)});
  $('#iCmd').textContent=`buildrax trace ${n.p} --direction ${dir}`}
 $('#dUp').onclick=()=>{dir='up';$('#dUp').setAttribute('aria-pressed',true);$('#dDn').setAttribute('aria-pressed',false);render()};
 $('#dDn').onclick=()=>{dir='down';$('#dDn').setAttribute('aria-pressed',true);$('#dUp').setAttribute('aria-pressed',false);render()};
 
 onView($('#xg'),()=>setTimeout(()=>{if(!sel)pick('bill')},500));
})();

/* feature showcase */
(()=>{
 const F=[
 {k:'Explore',img:'graph.webp',gif:'explore.gif',t:'Explore the map',p:'Open packages into segment boxes, click one to light up what it uses (blue) and what uses it (orange), then focus on a single package.',l:['Graph and Nodes views','Circular imports in red','Overview: most connected files'],c:'buildrax view path/to/repo --open'},
 {k:'Trace',img:'nodes-trace.webp',gif:'trace-code.gif',t:'Trace and read the code',p:'Step through how a file connects, then turn on Code view and click a file or a database to see the exact lines. Config secrets are masked.',l:['Inspector trace, one hop at a time','Code view (press K) with file:line','Impact before a refactor'],c:'buildrax trace src/billing.ts --direction up'},
 {k:'Flows',img:'flows-code.webp',gif:'flows.gif',t:'Follow endpoints to the database',p:'Every endpoint across frameworks. Follow one down lanes to PostgreSQL and open each step in a floating code window.',l:['Next.js, Express, Fastify, Hono, Koa, NestJS, FastAPI, Flask','Router prefixes resolved across files','Filter routes reaching a database'],c:'buildrax routes --reaching database:postgres'},
 {k:'Cost',img:'cost.webp',gif:'cost.gif',t:'Cost by traffic tier',p:'Monthly estimates at 100, 1k, 10k, 100k and 1M users with bottlenecks per tier. Change an assumption and every tier recomputes in the page.',l:['Dated AWS list prices with source','No price feed: "price needed", never a guess','Estimates, not measured bills'],c:'buildrax cost --mode product'}];
 const tabs=$('#ftabs'),img=$('#fImg'),pp=$('#fPP'),prog=$('#fProg');let cur=0,playing=false,timer,t0;
 F.forEach((f,i)=>{const b=document.createElement('button');b.className='tab';b.setAttribute('role','tab');b.textContent=f.k;b.onclick=()=>show(i,true);tabs.appendChild(b)});
 function stop(){clearInterval(timer);prog.style.width='0'}
 function play(){const f=F[cur];playing=true;img.src='assets/'+f.gif+'?'+Date.now();pp.textContent='❚❚ Showing live demo (click to stop)';stop();t0=Date.now();timer=setInterval(()=>{prog.style.width=Math.min(100,(Date.now()-t0)/220)%100+'%'},120)}
 function pause(){playing=false;stop();img.src='assets/'+F[cur].img;pp.textContent='▶ Play demo'}
 function show(i,user){cur=i;const f=F[i];$$('.tab',tabs).forEach((b,j)=>b.setAttribute('aria-selected',j===i));
  $('#fT').textContent=f.t;$('#fP').textContent=f.p;$('#fL').innerHTML=f.l.map(x=>'<li>'+esc(x)+'</li>').join('');$('#fC').textContent=f.c;
  img.alt=f.t+': screenshot of the BuildRAX viewer';pause();if(user||!reduce&&started)play()}
 pp.onclick=()=>playing?pause():play();
 let started=false;show(0);
 onView($('.show'),()=>{started=true;if(!reduce)play()});
})();

/* terminal: real CLI output from fixtures/sample-monorepo */
(()=>{
 const pre=$('#tm');
 const S=[
  ['c','buildrax scan .'],
  ['o',`<span class="bl">Scanned sample-monorepo</span>  (python, typescript)
  10 files · 6 modules · 4 external · 1 unresolved
  24 nodes · 16 edges
  <span class="r">1 circular dependency:</span>
    packages/api/src/services/billing.ts <-> packages/api/src/services/orders.ts
  parsed 10 file(s), reused 0 unchanged, in 1.0 s
`],
  ['c','buildrax digest .'],
  ['o',`BUILDRAX DIGEST repo=sm schema=buildrax-ir/v2
languages: python, typescript | files=10 nodes=24 edges=16
<span class="m">static analysis only: not observed at runtime</span>

MODULES
M2 packages/api [npm @sample/api] files=4 <span class="r">CYCLE</span> -> X1 X4 M3 M5 U1
M3 packages/shared files=2
M4 services/worker [python] files=4 -> M1 X2 X3

CYCLES
packages/api/src/services/billing.ts <-> .../orders.ts

UNRESOLVED IMPORTS <span class="m">(do not assume they exist)</span>
packages/api/src/server.ts:5 ./missing.js
`],
  ['c','buildrax trace packages/api/src/services/billing.ts --direction up'],
  ['o',`Everything that depends on billing.ts (what could break if it changes)
3 node(s), 3 file(s)
  <span class="o">packages/api/src/routes/orders.ts:2</span>
  <span class="o">packages/api/src/services/orders.ts:1</span>
    <span class="o">packages/api/src/server.ts:4</span>
`]];
 let run=0;
 async function go(){const id=++run;pre.innerHTML='';
  const w=ms=>new Promise(r=>setTimeout(r,reduce?0:ms));
  for(const [k,t] of S){if(id!==run)return;
   if(k==='c'){const line=document.createElement('div');line.innerHTML='<span class="p">$</span> <span></span><span class="caret"></span>';pre.appendChild(line);const sp=line.children[1];
    for(const ch of t){if(id!==run)return;sp.textContent+=ch;await w(22)}await w(250);line.querySelector('.caret').remove()}
   else{const d=document.createElement('div');d.innerHTML=t;pre.appendChild(d);d.style.animation='slide .5s both';await w(900)}
   pre.scrollTop=pre.scrollHeight}}
 $('#replay').onclick=go;onView($('#tm'),go);
})();

/* token bars + counters */
function count(el,to,dur,dec){const s=performance.now();(function f(t){const p=reduce?1:Math.min(1,(t-s)/dur),e=1-Math.pow(1-p,3),v=to*e;el.textContent=dec?v.toFixed(dec):Math.round(v).toLocaleString();if(p<1)requestAnimationFrame(f)})(s)}
onView($('#tok'),()=>$$('#tok .tr').forEach((r,i)=>setTimeout(()=>{$('i',r).style.width=Math.max(.8,+$('i',r).dataset.w)+'%';count($('b',r),+$('b',r).dataset.n,1600)},i*250)));
onView($('#trust .num').closest('.card'),()=>$$('#trust .num').forEach(n=>count(n,+n.dataset.c,1400,+n.dataset.d||0)));

/* personas */
(()=>{
 const P=[
 {n:'Indie hacker',s:[['As an indie hacker returning to a side project after two months, I want a one-screen overview of its packages and hubs, so that I can start a change without rereading everything.','buildrax view --open'],['As an indie hacker planning a launch, I want to know what the app would cost at 10k and 100k users and what breaks first, so that I can price my plan and avoid surprises.','buildrax cost --mode product']]},
 {n:'Developer',s:[['As a developer about to refactor billing.ts, I want every file that depends on it, hop by hop, with the import lines, so that I know what to retest.','buildrax trace src/billing.ts --direction up'],['As a developer reviewing a pull request, I want the architecture changes in plain words, so that I can spot a new dependency or a cycle without reading the whole diff.','buildrax diff --since origin/main --markdown']]},
 {n:'Vibe-coder',s:[['As a vibe-coder who let an AI build the backend, I want to see every endpoint and which database each one touches, so that I can check it did what I asked.','buildrax routes --reaching database:postgres'],['As a vibe-coder, I want to click an arrow and read the lines that create it, so that I can understand generated code without opening ten files.','Code view: press K, then click the arrow']]},
 {n:'Context engineer',s:[['As a context engineer, I want a bounded, evidence-linked context pack for a question, so that my agent answers from facts and spends a few thousand tokens instead of hundreds of thousands.','buildrax context "how does checkout talk to Stripe" --budget 3000'],['As a context engineer, I want the same repository to always produce the same IDs and digest, so that prompts and caches are stable across runs.','Deterministic IDs and scans, checked by tests']]},
 {n:'Founder / builder',s:[['As a solo technical founder, I want one place for the technical picture an investor, contractor or new hire asks about, so that I can answer with evidence.','buildrax view · buildrax cost · buildrax research --online'],['As a founder, I want to know which runtimes are end-of-life and which pinned versions have known advisories, so that I can fix risk early.','buildrax research --online']]},
 {n:'Team',s:[['As a team lead, I want the map rebuilt on every push with an architecture summary on each PR, so that erosion is caught in review.','See docs/ci.md'],['As a team, we want CI to fail when a PR introduces a circular dependency, so that cycles never merge unnoticed.','buildrax diff --since origin/main (optional check)']]}];
 const tl=$('#ptabs'),body=$('#pBody');
 P.forEach((p,i)=>{const b=document.createElement('button');b.setAttribute('role','tab');b.textContent=p.n;b.onclick=()=>sel(i);tl.appendChild(b)});
 function sel(i){$$('button',tl).forEach((b,j)=>b.setAttribute('aria-selected',j===i));
  body.innerHTML='<h3>'+esc(P[i].n)+'</h3>'+P[i].s.map(([t,c])=>`<div class="story"><p style="margin:0">${esc(t)}</p><div class="cmd"><code>${esc(c)}</code><button data-copy>copy</button></div></div>`).join('');body.animate&&!reduce&&body.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:350})}
 sel(0);
})();

/* CI card */
onView($('#pr'),()=>{const t=ms=>new Promise(r=>setTimeout(r,reduce?0:ms));(async()=>{await t(900);$('#prW').style.opacity=1;await t(700);$('#prD').className='dot bad';$('#prT').textContent='architecture check: failed (1 new circular dependency)'})()});

/* copy buttons (delegated) */
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;const txt=$('code',b.parentElement).textContent;
 (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>{b.textContent='copied ✓';setTimeout(()=>b.textContent='copy',1400)}).catch(()=>{const r=document.createRange();r.selectNodeContents($('code',b.parentElement));getSelection().removeAllRanges();getSelection().addRange(r)})});
})();
