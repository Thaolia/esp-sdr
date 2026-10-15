'use strict';
const $=id=>document.getElementById(id);
let gainMode='HARDWARE';
function preferredSampleRate(rates=radio.rxRates){return rates.includes(80000000)?80000000:Math.max(...rates);}
function applyRadioProfile(){
 const tuning=radio.frequencyInput();$('frequency').min=tuning.min;$('frequency').max=tuning.max;$('frequency').step=tuning.step;
 $('gain').min=radio.gainMin;$('gain').max=radio.gainMax;$('gain').step=radio.gainStep;$('gain').value=Math.min(Math.max(40,radio.gainMin),radio.gainMax);$('gainValue').textContent=`${$('gain').value} / ${radio.gainMax}`;
 if(!radio.hasGain||(!radio.hasHardwareAgc&&gainMode==='HARDWARE'))gainMode='MANUAL';
 for(const [id,rates] of [['rate',radio.rxRates]]){
  for(const o of $(id).options)o.disabled=!rates.includes(Number(o.value));
  $(id).value=String(preferredSampleRate(rates));
 }
 const bandwidth=radio.bandwidthRange;
 analogBandwidth=bandwidth?(bandwidth[0]<=20&&bandwidth[1]>=20&&(20-bandwidth[0])%bandwidth[2]===0?20:bandwidth[3]):0;
 $('bandwidthControl').hidden=!bandwidth;
 if(bandwidth){$('bandwidth').min=bandwidth[0];$('bandwidth').max=bandwidth[1];$('bandwidth').step=bandwidth[2];$('bandwidth').value=analogBandwidth||bandwidth[1];}
 for(const option of $('bits').options)option.disabled=!radio.sampleBits.includes(Number(option.value));
 if(!radio.sampleBits.includes(Number($('bits').value)))$('bits').value=String(radio.sampleBits[0]);

 if(!radio.validFrequency(tuneFrequency)){tuneFrequency=2412;$('frequency').value='2412';}
 state();labels();
}
// Capture mode: 'iq' burst snapshots, 'spec' shared on-chip spectrum stream,
// 'cspec' ESPsoup continuous waterfall, 'sweep' ESPsoup wideband panorama.
let captureMode='iq',connectionBusy=false,firmwareHandoff=false;
const isSpec=()=>captureMode==='spec',isCspec=()=>captureMode==='cspec',isSweep=()=>captureMode==='sweep';
let firmwareCheck=0,firmwareUpdate=null;
// Frequency calibration: crystal error in ppm. The crystal drives both the LO
// and the sample clock, so a single factor scales every displayed frequency
// (true = displayed * (1 + ppm/1e6)). Correction is display-only: tuning stays
// in whole nominal MHz, and the ppm error is far below that resolution.
let freqCal=0;
try{const v=Number(localStorage.getItem('espSdrFreqCal'));if(Number.isFinite(v)&&Math.abs(v)<=500)freqCal=v;}catch(e){}
const freqFactor=()=>1+freqCal/1e6;
let peakHzNominal=null,calObservedHz=null,calPicking=false;
// Per-board configuration profiles, keyed by USB serial (native/WebUSB) or model.
let currentBoardKey=null,loadingProfile=false,saveTimer=0;
let connected=false,paused=false,latest=null,trace=null,maximum=null,previous=0,key='',running=false,tuneFrequency=2412,analogBandwidth=20;
// Dual-device gap-fill state (second board B mirrors A's band; see dualStreamLoop below).
let radioB=null,bPort=null,dualOn=false,dualMerger=null,dualCfg=null,dualRAF=0,dualBState='',dualRate={a:[],b:[],m:[]},bRetryTimer=0;
// ---- debug / UART traffic logger (feeds the right-side panel) -------------
// radio.command()/line() call radio.onwire, so TX/RX control lines land here.
// The high-rate IQ path uses read() and is never logged.
const dbg=(()=>{const el=$('debugLog'),MAX=400,sym={tx:'»',rx:'«',ev:'·'},hotTx=/^CAP\d/;let buf=[],open=false,prevConn=false;
 const paint=l=>{const d=document.createElement('div');d.className='dbg-'+l.d;d.textContent=`${l.t} ${sym[l.d]} ${l.m}`;el.append(d);while(el.childElementCount>MAX)el.firstChild.remove();el.scrollTop=el.scrollHeight;};
 // Drop the per-capture IQ chatter — CAP../DATA and the GAIN? probe + its echo fire every
 // frame on the hot path. Cheap prefix test BEFORE any alloc; keeps the control-plane log readable.
 const hotRx=/^(DATA |DATAT |GAIN |SWP |SPL |BLK |PKT |CSL |VFL |GPK )/;
 const log=(d,m)=>{if(d==='tx'?(!m||m==='GAIN?'||hotTx.test(m)):hotRx.test(m))return;const l={t:new Date().toLocaleTimeString(),d,m:(''+m).slice(0,400)};buf.push(l);if(buf.length>MAX)buf.shift();if(open)paint(l);};
 log.setOpen=v=>{open=v;if(open){el.textContent='';for(const l of buf)paint(l);}};
 log.clear=()=>{buf=[];el.textContent='';};
 log.stat=()=>{const st=$('debugStat');if(!st)return;
  if(!connected)st.textContent='Disconnected';
  else{const d=deviceDiag,p=[`${radio.deviceName||'ESP32'} · ${radio.transport||'—'} · ${radio.transport==='UART'?radio.baudRate/1e6+' MBaud':radio.transport==='USB'?'USB-CDC':'—'}`,`drops ${radio.droppedCaptures} · CRC err ${radio.spectrumCrcErrors}`];
   if(d?.fwopt||radio.fwopt)p.push(d?.fwopt||radio.fwopt);
   if(d?.temp!=null)p.push(`${d.temp.toFixed(1)} °C`);
   if(d?.heapFree!=null)p.push(`heap ${(d.heapFree/1024).toFixed(0)}k · max ${(d.heapLargest/1024).toFixed(0)}k`);
   if(d?.tunem!=null)p.push(`TUNEM ${d.tunem}`);
   if(d?.engine)p.push(`engine ${d.engine}`);
   st.textContent=p.join(' · ');}
  if(prevConn!==connected){prevConn=connected;log('ev',connected?`connected: ${radio.deviceName||'ESP32'}`:'disconnected');}};
 return log;})();
radio.onwire=(dir,msg)=>dbg(dir,msg);
let deviceDiag=null; // last ESPsoup diagnostics snapshot (FWOPT/TEMP/HEAP/TUNEM/ENGINE)
let loopDone=Promise.resolve();
const spec=$('spectrum'),water=$('waterfall'),sc=spec.getContext('2d'),wc=water.getContext('2d');
const lut=Array.from({length:256},(_,i)=>{const stops=[[3,8,23],[18,31,81],[38,63,153],[30,139,181],[66,213,174],[217,237,103],[255,162,61],[255,244,228]];const p=i/255*(stops.length-1),j=Math.min(stops.length-2,Math.floor(p)),t=p-j;return stops[j].map((v,k)=>Math.round(v*(1-t)+stops[j+1][k]*t));});

// ---- display zoom (wheel), pan (drag), reset (double-click) -------------
// view = visible fraction [a, b] of the received span; the waterfall keeps its
// rows (newest first) so it can be redrawn for any view.
let view={a:0,b:1},waterHist=[],drag=null,suppressClick=false,keepView=false,tuneClick=null;
var specCov=0; // fraction of the received samples that went through an on-chip FFT
function viewFrac(x,el){const r=el.getBoundingClientRect();return view.a+(x-r.left)/r.width*(view.b-view.a);}
function setView(a,b,free){const nb=(latest&&latest.fft)||2048,minW=Math.max(8/nb,1/1024);let w=Math.max(minW,Math.min(1,b-a));
 if(free){b=a+w;}else if(w>=1){a=0;b=1;}else{a=Math.max(0,Math.min(1-w,a));b=a+w;}view={a,b};redrawWater();draw();labels();}
// released beyond the received span: retune the LO by whole MHz so the view centre is covered
function retuneToView(){const c=latest||config(),span=c.rate/1e6,shift=Math.round(((view.a+view.b)/2-.5)*span);
 if(!connected||!shift){setView(view.a,view.b);return;}const lo0=loFrequency();tuneFrequency=radio.nearestFrequency(tuneFrequency+shift);$('frequency').value=tuneFrequency;
 const d=(loFrequency()-lo0)/span;keepView=true;setView(view.a-d,view.b-d);}
function wmap(W,nb){if(!waterMap||waterMap.W!==W||waterMap.nb!==nb||waterMap.a!==view.a||waterMap.b!==view.b){
 const lo=new Uint16Array(W),hi=new Uint16Array(W),span=view.b-view.a;
 for(let x=0;x<W;x++){const f0=view.a+x/W*span,f1=view.a+(x+1)/W*span;lo[x]=Math.max(0,Math.min(nb,Math.floor(f0*nb)));hi[x]=Math.max(lo[x],Math.min(nb,Math.ceil(f1*nb)));}
 waterMap={W,nb,a:view.a,b:view.b,lo,hi};}return waterMap;}
function paintRows(rows,y0){const n=rows.length;if(!n)return;const W=water.width,nb=rows[0].length,m=wmap(W,nb),floor=Number($('floor').value),range=Number($('range').value),scale=255/range;
 if(!lut32){lut32=new Uint32Array(256);for(let i=0;i<256;i++){const [r,g,b]=lut[i];lut32[i]=(255<<24|b<<16|g<<8|r)>>>0;}}
 const img=wc.createImageData(W,n),px=new Uint32Array(img.data.buffer),lo=m.lo,hi=m.hi;
 for(let r=0;r<n;r++){const row=rows[r],base=r*W;for(let x=0;x<W;x++){let v=hi[x]>lo[x]?row[lo[x]]:-Infinity;for(let j=lo[x]+1;j<hi[x];j++)if(row[j]>v)v=row[j];let q=(v-floor)*scale;q=q<0?0:q>255?255:q|0;px[base+x]=lut32[q];}}
 wc.putImageData(img,0,y0);}
function pushWater(rowsNewestFirst){waterHist=rowsNewestFirst.concat(waterHist);if(waterHist.length>water.height)waterHist.length=water.height;}
function redrawWater(){wc.fillStyle='#11191e';wc.fillRect(0,0,water.width,water.height);paintRows(waterHist.slice(0,water.height),0);}
for(const el of [spec,water,$('axisCanvas')]){
 el.addEventListener('wheel',e=>{clearTimeout(tuneClick);e.preventDefault();const f=viewFrac(e.clientX,el),k=e.deltaY<0?0.8:1.25,a=f-(f-view.a)*k;setView(a,a+(view.b-view.a)*k);},{passive:false});
 el.addEventListener('mousedown',e=>{clearTimeout(tuneClick);if(e.button===0)drag={x:e.clientX,a:view.a,b:view.b,el,moved:false};});
 el.addEventListener('dblclick',e=>{clearTimeout(tuneClick);e.preventDefault();setView(0,1);});
 el.title='Wheel: zoom · drag: pan (past the edge = retune) · double-click: full span · click: tune';
}
window.addEventListener('mousemove',e=>{if(!drag)return;const dx=e.clientX-drag.x;if(!drag.moved&&Math.abs(dx)<4)return;drag.moved=true;
 const r=drag.el.getBoundingClientRect(),d=dx/r.width*(drag.b-drag.a);setView(drag.a-d,drag.b-d,connected);});
window.addEventListener('mouseup',()=>{if(drag&&drag.moved)suppressClick=true;const was=drag&&drag.moved;drag=null;if(was&&(view.a<-1e-9||view.b>1+1e-9))retuneToView();});
// ---- frequency axis: nice 1-2-5 ticks, shared with the spectrum grid -------
function axisTicks(c,W){const k=freqFactor(),span=(view.b-view.a)*c.rate*k,f0=(c.frequency*1e6+(view.a-.5)*c.rate)*k,f1=f0+span;
 const raw=span/Math.max(2,W/110),p=10**Math.floor(Math.log10(raw)),m=raw/p,step=(m<1.5?1:m<3.5?2:m<7.5?5:10)*p,minor=step/(step/p===2?4:5);
 const x=f=>(f-f0)/span*W,major=[],minors=[];for(let f=Math.ceil(f0/minor)*minor;f<=f1;f+=minor){const r=Math.round(f/minor)*minor;if(Math.abs(r/step-Math.round(r/step))<1e-6)major.push(r);else minors.push(r);}
 return {step,major,minors,x};}
function drawAxis(c){const el=$('axisCanvas');if(!el)return;const d=Math.min(devicePixelRatio||1,2),W=Math.round(el.clientWidth*d),H=Math.round(el.clientHeight*d);
 if(el.width!==W||el.height!==H){el.width=W;el.height=H;}const g=el.getContext('2d');g.fillStyle='#182126';g.fillRect(0,0,W,H);if(!c||!c.rate)return;
 const t=axisTicks(c,W),dec=Math.max(0,Math.ceil(-Math.log10(t.step/1e6)-1e-9));g.strokeStyle='#5b686e';g.lineWidth=d;g.beginPath();
 for(const f of t.minors){const x=Math.round(t.x(f))+.5;g.moveTo(x,0);g.lineTo(x,4*d);}g.stroke();g.strokeStyle='#a1adb2';g.beginPath();
 for(const f of t.major){const x=Math.round(t.x(f))+.5;g.moveTo(x,0);g.lineTo(x,9*d);}g.stroke();
 g.font=`${13*d}px Carlito,sans-serif`;g.fillStyle='#c0c9cd';g.textBaseline='bottom';
 for(const f of t.major){const s=(f/1e6).toFixed(dec),tw=g.measureText(s).width;g.fillText(s,Math.max(2*d,Math.min(W-tw-2*d,t.x(f)-tw/2)),H-3*d);}
 const mark=(fMHz,col)=>{const x=t.x(fMHz*1e6*freqFactor());if(x<0||x>W)return;g.fillStyle=col;g.beginPath();g.moveTo(x-5*d,0);g.lineTo(x+5*d,0);g.lineTo(x,7*d);g.closePath();g.fill();};
 mark(c.frequency,'#e0a040');if(tuneFrequency!==c.frequency)mark(tuneFrequency,'#37c964');drawBandTicks(t.x,W,H,d,g,(view.b-view.a)*c.rate);}
// ---- WiFi / BLE / Bluetooth channel markers (display overlay only) ---------
// Channel center frequencies in MHz. BLE is keyed by RF index (2402+2*i); its
// logical channel numbers are not frequency-ordered, so advertising channels
// (37/38/39 at 2402/2426/2480) are tagged by frequency, not by number.
const markerBands={
 wifi24:{color:'#37c964',chans:[...Array(13)].map((_,i)=>({n:i+1,f:2412+5*i,w:20})).concat([{n:14,f:2484,w:20}])},
 wifi5:{color:'#4aa3ff',chans:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165].map(n=>({n,f:5000+5*n,w:20}))},
 ble:{color:'#c77dff',chans:[...Array(40)].map((_,i)=>{const f=2402+2*i,adv=f===2402?37:f===2426?38:f===2480?39:0;return {n:i,f,w:2,adv};})},
 bt:{color:'#8f9ca2',chans:[...Array(79)].map((_,i)=>({n:i,f:2402+i,w:1}))}
};
let markerPrefs={wifi24:true,wifi5:false,ble:false,bt:false,waterfall:false};
try{const v=JSON.parse(localStorage.getItem('espSdrMarkers')||'null');if(v&&typeof v==='object')markerPrefs={...markerPrefs,...v};}catch(e){}
// Draw enabled channel markers on the spectrum: faint band tint + center line,
// with channel numbers thinned by pixel spacing so dense bands stay legible.
function drawChannelMarkers(c,ctx,W,H,d,linesOnly){
 if(!c||!c.rate)return;
 const k=freqFactor(),span=(view.b-view.a)*c.rate*k,f0=(c.frequency*1e6+(view.a-.5)*c.rate)*k,mapX=f=>(f-f0)/span*W;
 ctx.save();ctx.font=`${11*d}px Carlito,sans-serif`;ctx.textBaseline='top';
 for(const key in markerBands){
  if(!markerPrefs[key])continue;
  const band=markerBands[key];ctx.strokeStyle=band.color;ctx.fillStyle=band.color;
  // Bluetooth classic (79 x 1 MHz): per-channel ticks only when zoomed in enough
  // to stay readable; at a wide span show the whole band as one faint region
  // with a label so an enabled checkbox is never a silent no-op.
  if(key==='bt'&&span>40e6){const x0=mapX(2401.5e6),x1=mapX(2480.5e6);if(x1>0&&x0<W){if(!linesOnly){ctx.globalAlpha=.05;ctx.fillRect(x0,0,x1-x0,H);}ctx.globalAlpha=1;ctx.fillText('BT',Math.max(2,x0+3),2*d);}continue;}
  let lastLabel=-1e9;
  for(const ch of band.chans){
   const x=mapX(ch.f*1e6);if(x<-20||x>W+20)continue;
   const emph=ch.adv;
   if(ch.w&&!linesOnly){const x0=mapX((ch.f-ch.w/2)*1e6),x1=mapX((ch.f+ch.w/2)*1e6);ctx.globalAlpha=emph?.1:.045;ctx.fillRect(x0,0,x1-x0,H);}
   ctx.globalAlpha=emph?.6:.3;ctx.lineWidth=(emph?1.6:.8)*d;
   const xr=Math.round(x)+.5;ctx.beginPath();ctx.moveTo(xr,0);ctx.lineTo(xr,H);ctx.stroke();
   const text=ch.adv?('A'+ch.adv):String(ch.n);
   if(x>=0&&x<=W&&(emph||x-lastLabel>=28*d)){ctx.globalAlpha=1;const tw=ctx.measureText(text).width;ctx.fillText(text,Math.max(1,Math.min(W-tw-1,x-tw/2)),2*d);lastLabel=x;}
  }
 }
 ctx.restore();
}
// Channel markers mirrored onto the waterfall via a non-scrolling overlay
// canvas: lines + labels only (no band tint), cleared when disabled or idle.
function drawWaterfallMarkers(){
 const wm=$('waterfallMarkers');if(!wm)return;
 const ctx=wm.getContext('2d');ctx.clearRect(0,0,wm.width,wm.height);
 if(!markerPrefs.waterfall||!latest)return;
 drawChannelMarkers({frequency:latest.frequency,rate:latest.rate},ctx,wm.width,wm.height,1,true);
}
// Short colored channel ticks along the bottom edge of the frequency axis,
// echoing the spectrum markers. Digits have no descenders, so the bottom strip
// stays clear of the MHz labels drawn just above it.
function drawBandTicks(mapX,W,H,d,g,span){
 for(const key in markerBands){
  if(!markerPrefs[key]||(key==='bt'&&span>40e6))continue;
  g.fillStyle=markerBands[key].color;
  for(const ch of markerBands[key].chans){
   const x=mapX(ch.f*1e6);if(x<0||x>W)continue;
   const t=(ch.adv?6:3)*d;g.globalAlpha=ch.adv?.95:.65;g.fillRect(Math.round(x),H-t,Math.max(1,d),t);
  }
 }
 g.globalAlpha=1;
}
// ---- 0 Hz handling / offset LO ---------------------------------------------
try{const v=localStorage.getItem('espSdrDcMode');if(v&&$('dcMode').querySelector(`option[value="${v}"]`))$('dcMode').value=v;}catch(e){}
function loOffset(rate){return $('dcMode').value==='offset'?(rate>=40000000?5:2):0;}
function loFrequency(){const o=loOffset(Number($('rate').value));if(!o)return tuneFrequency;
 for(const f of [tuneFrequency-o,tuneFrequency+o])if(radio.validFrequency(f))return f;return tuneFrequency;}
$('dcMode').onchange=()=>{try{localStorage.setItem('espSdrDcMode',$('dcMode').value);}catch(e){}labels();draw();};

async function api(path,body){let value;
 if(path==='connect')value=await radio.connect({port:body.port});
 else if(path==='disconnect'){value=await radio.run(()=>radio.close());}
 else if(path==='frame')value=await radio.capture(body);
 else throw Error('Unknown operation');
 return {json:async()=>value};
}
function error(e,communication=false){
 const box=$('error'),text=$('errorText');text.textContent=e?.message||e;box.hidden=!e;if(e)dbg('ev','ERROR: '+(e?.message||e));
 if(e&&communication){const link=document.createElement('a');link.href='flash.html';link.textContent='Install / update ESP-SDR firmware';link.onclick=openFirmwareInstaller;text.append(' ',link);}
}
$('dismissError').onclick=()=>error('');
function config(){return {frequency:loFrequency(),rate:Number($('rate').value),bits:Number($('bits').value),fft:Number($('fft').value),bandwidth:analogBandwidth,gainMode:gainMode,gain:Number($('gain').value),trigger:{mode:'free'}};}
function clear(){trace=null;maximum=null;waterHist=[];if(!keepView)view={a:0,b:1};keepView=false;wc.fillStyle='#11191e';wc.fillRect(0,0,water.width,water.height);draw();}
function resize(){const d=Math.min(devicePixelRatio||1,2);spec.width=Math.round(spec.clientWidth*d);spec.height=Math.round(spec.clientHeight*d);water.width=Math.round(water.clientWidth);water.height=Math.round(water.clientHeight);const wm=$('waterfallMarkers');if(wm){wm.width=water.width;wm.height=water.height;wm.style.top=water.offsetTop+'px';wm.style.left=water.offsetLeft+'px';wm.style.width=water.clientWidth+'px';wm.style.height=water.clientHeight+'px';}wc.fillStyle='#11191e';wc.fillRect(0,0,water.width,water.height);redrawWater();draw();labels();}
function fmtHz(hz){const a=Math.abs(hz);return a>=1e9?(hz/1e9).toFixed(6)+' GHz':a>=1e6?(hz/1e6).toFixed(3)+' MHz':a>=1e3?(hz/1e3).toFixed(1)+' kHz':hz.toFixed(0)+' Hz';}
function measBar(c){
 const k=freqFactor(),specM=connected&&isSpec(),cspecM=connected&&isCspec(),sweepM=connected&&isSweep();
 const n=specM?specConfig().fft:cspecM?Number($('cspecFft').value):(latest?.fft)||c.fft;
 const center=c.frequency*1e6*k,span=c.rate*k;
 // Hann window: 3 dB bandwidth 1.44 bins
 const rbw=1.44*c.rate/n,top=Number($('floor').value)+Number($('range').value),div=Number($('range').value)/4;
 const det=specM?($('specDetector').value==='max'?'max-hold':'average'):cspecM?($('cspecDetector').value==='max'?'max-hold':'average'):'average';
 const acq=specM?(specLast?`${(specLast.pairs/c.rate*1e3).toFixed(2)} ms · ${specLast.ffts} FFT · ${radio.spectrumContinuous(Number($('rate').value),Number($('fft').value))?'continuous capture':'snapshot'}`:'—')
  :cspecM?'gap-free continuous'
  :sweepM?(latest?.steps?`${latest.steps} steps · ${latest.sweepMs?latest.sweepMs.toFixed(0)+' ms':'—'}`:'—')
  :(latest?.samples?`${(latest.samples/c.rate*1e3).toFixed(3)} ms burst`:'—');
 const modeLabel=specM?'SPEC on-chip':cspecM?'CSPEC continuous':sweepM?'Panorama sweep':'burst IQ';
 const item=(k,v)=>`<span>${k} <b style="color:#e8eef0;font-weight:600">${v}</b></span>`;
 $('meas').innerHTML=[item('Start',fmtHz(center-span/2)),item('Center',fmtHz(center)),item('Span',fmtHz(span)),item('Stop',fmtHz(center+span/2)),
  item('RBW',fmtHz(rbw)),item('Bins',`${n}`),item('Ref',`${top} dBFS`),item('Div',`${div} dB`),item('Det',det),item('Acq',acq),item('Mode',modeLabel)].join('');
}
function labels(f){tuningWarning();const c=f||config();drawAxis(c);measBar(c);}
function draw(){const w=spec.width,h=spec.height,d=Math.min(devicePixelRatio||1,2),floor=Number($('floor').value),range=Number($('range').value);sc.fillStyle='#182126';sc.fillRect(0,0,w,h);sc.lineWidth=d;sc.font=`${14*d}px Carlito,sans-serif`;
for(let i=0;i<=4;i++){const y=i*h/4;sc.strokeStyle='#344047';sc.beginPath();sc.moveTo(0,y);sc.lineTo(w,y);sc.stroke();sc.fillStyle='#a1adb2';sc.fillText(`${Math.round(floor+range-i*range/4)}`,8*d,Math.max(16*d,y-5*d));}
{const c=latest?{frequency:latest.frequency,rate:latest.rate}:config(),t=axisTicks(c,w);sc.strokeStyle='#202a2f';sc.beginPath();for(const f of t.minors){const x=Math.round(t.x(f))+.5;sc.moveTo(x,0);sc.lineTo(x,h);}sc.stroke();sc.strokeStyle='#33424a';sc.beginPath();for(const f of t.major){const x=Math.round(t.x(f))+.5;sc.moveTo(x,0);sc.lineTo(x,h);}sc.stroke();if(tuneFrequency!==c.frequency){const x=t.x(tuneFrequency*1e6*freqFactor());sc.save();sc.setLineDash([4*d,4*d]);sc.strokeStyle='#37c96490';sc.beginPath();sc.moveTo(x,0);sc.lineTo(x,h);sc.stroke();sc.restore();}drawAxis(c);drawChannelMarkers(c,sc,w,h,d);drawWaterfallMarkers();}
function line(values,color,fill){if(!values)return;sc.beginPath();const L=values.length-1,sp=view.b-view.a,i0=Math.max(0,Math.floor(view.a*L)-1),i1=Math.min(L,Math.ceil(view.b*L)+1);for(let i=i0;i<=i1;i++){const v=values[i],x=(i/L-view.a)/sp*w,y=Math.max(0,Math.min(h,(1-(v-floor)/range)*h));if(i>i0)sc.lineTo(x,y);else sc.moveTo(x,y);}sc.strokeStyle=color;sc.lineWidth=1.2*d;sc.stroke();if(fill){sc.lineTo(w,h);sc.lineTo(0,h);sc.closePath();const g=sc.createLinearGradient(0,0,0,h);g.addColorStop(0,'#37c96445');g.addColorStop(1,'#37c96403');sc.fillStyle=g;sc.fill();}}
if($('hold').checked)line(maximum,'#e6b969',false);line(trace,'#37c964',true);}
function render(f){const k=[f.frequency,f.rate,f.bits,f.fft,f.bandwidth,f.gainMode,f.gainMode==='MANUAL'?f.gain:'HARDWARE'].join('/');if(key!==k){key=k;clear();}latest=f;const a=Number($('average').value);trace=f.spectrum.map((v,i)=>trace?10*Math.log10(a*10**(trace[i]/10)+(1-a)*10**(v/10)):v);maximum=f.spectrum.map((v,i)=>maximum?Math.max(maximum[i],v):v);draw();
wc.drawImage(water,0,0,water.width,water.height-1,0,1,water.width,water.height-1);pushWater([Float32Array.from(f.spectrum)]);paintRows([waterHist[0]],0);autoScale(trace);
$('gainStatus').textContent=f.gain_actual?.mode==='HARDWARE'?'Hardware AGC':f.gain_actual?`Manual · index ${f.gain_actual.index}`:'Update SDR firmware for gain control.';$('empty').hidden=true;labels(f);$('fpsLabel').textContent='frames/s';$('throughputLabel').textContent='kS/s delivered';$('latencyLabel').textContent='ms / capture + transfer';const now=performance.now();$('fps').textContent=previous?(1000/(now-previous)).toFixed(1):'—';previous=now;$('throughput').textContent=f.delivered_ksps.toFixed(1);$('latency').textContent=f.elapsed_ms.toFixed(1);peakHzNominal=f.peak_hz;$('peak').textContent=(f.peak_hz*freqFactor()/1e6).toFixed(4);$('crc').textContent=`CRC OK · #${f.sequence}${f.dropped_captures?` · ${f.dropped_captures} dropped · ${f.samples} samples`:''}`;}
async function loop(){
 if(running)return loopDone;
 running=true;
 let finishLoop;loopDone=new Promise(resolve=>{finishLoop=resolve;});
 try{
  while(connected&&!paused){
   try{
    if(dualActive()&&(radio.hasSpec||radio.hasCspec))await dualStreamLoop();
    else if(isSpec()&&radio.hasSpec)await specLoop();
    else if(isCspec()&&radio.hasCspec)await cspecLoop();
    else if(isSweep()&&radio.hasSweep)await sweepLoop();
    else{
    const f=await(await api('frame',config())).json();
    if(connected&&!paused&&!radio.changingBaud&&selectRxFrame(f))render(f);
    }
    if(!radio.changingBaud)error('');
   }catch(e){
    if(radio.changingBaud)break;
    paused=true;
    const disconnected=!!radio.failed;
    if(disconnected){connected=false;if(radioB)await disconnectB();await radio.run(()=>radio.close()).catch(()=>{});}
    state();
    error(disconnected?e:`${e?.message||e} Change the settings and select Resume.`,disconnected);
    break;
   }
   if(connected&&!paused)await new Promise(r=>setTimeout(r,10));
  }
 }finally{running=false;finishLoop();}
}
let serialWarningDismissedAt=0;
function serialWarning(){
 const warning=$('serialWarning'),button=$('lowerBaud');
 const errors=radio.droppedCaptures+radio.spectrumCrcErrors;
 // Counters reset on a new device identity; dismissal never clears diagnostics.
 if(!connected||errors<serialWarningDismissedAt)serialWarningDismissedAt=0;
 warning.hidden=!connected||errors-serialWarningDismissedAt<3;
 const available=radio.supportsBaudChange&&radio.transport==='UART'&&radio.baudRate>1000000;
 button.hidden=!available;button.disabled=(!!radio.changingBaud||!!radio.changingGpio);
 button.textContent=radio.changingBaud?'Switching…':'Switch to 1 MBaud';
 $('serialWarningText').textContent=available
  ?'Repeated capture / CRC errors. A slower serial connection may help; the RF sample rate stays the same.'
  :radio.transport==='UART'&&radio.baudRate===1000000
   ?'Capture / CRC errors continue at 1 MBaud. Check the USB connection or try a smaller FFT.'
   :radio.transport==='USB'?'Repeated capture / CRC errors. Check the USB connection or try a smaller FFT.'
   :'Repeated capture / CRC errors. Check the USB connection. Updated firmware enables a slower UART connection.';
}
$('dismissSerialWarning').onclick=()=>{
 serialWarningDismissedAt=radio.droppedCaptures+radio.spectrumCrcErrors;
 serialWarning();
};
function state(){
 firmwareWarning();
 updateGpioControls();
 if(!connected||!isSpec())$('chipStats').hidden=true;
 serialWarning();
 $('baudStatus').hidden=!connected||radio.transport!=='UART';
 $('baudStatus').textContent=radio.transport==='UART'?`${radio.baudRate/1000000} MBaud`:'';
 $('connect').disabled=connectionBusy||(!!radio.changingBaud||!!radio.changingGpio);
 $('openOther').disabled=connected||$('connect').disabled||!navigator.serial;
 $('openUSB').disabled=connected||$('connect').disabled||!navigator.usb;
 $('openRecent').disabled=connected||$('connect').disabled||!savedPort();
 tuningWarning();
 // Channel markers (.mk) are display-only and stay usable while disconnected.
 for(const control of document.querySelectorAll('aside input:not(.mk),aside select'))control.disabled=!connected||(!!radio.changingBaud||!!radio.changingGpio);
 const busy=(!!radio.changingBaud||!!radio.changingGpio);
 // Capture-mode availability + the mode bar (lives in the spectrum chart, outside the aside).
 const canSpec=connected&&radio.canStreamSpectrum,canCspec=connected&&radio.hasCspec,canSweep=connected&&radio.hasSweep;
 {const gf=$('toggleGapFill');if(gf){gf.hidden=!(connected&&(canSpec||canCspec));gf.textContent=radioB?'Remove gap-fill device':'Add gap-fill device…';}updateDualStatus();}
 if((isSpec()&&!canSpec)||(isCspec()&&!canCspec)||(isSweep()&&!canSweep))captureMode='iq';
 $('modeSpec').hidden=!canSpec;$('modeCspec').hidden=!canCspec;$('modeSweep').hidden=!canSweep;
 for(const [id,m] of [['modeIq','iq'],['modeSpec','spec'],['modeCspec','cspec'],['modeSweep','sweep']]){$(id).setAttribute('aria-pressed',String(captureMode===m));$(id).disabled=!connected||busy;}
 $('iqControls').hidden=captureMode!=='iq';$('specOptions').hidden=!isSpec();$('sweepOptions').hidden=!isSweep();$('cspecOptions').hidden=!isCspec();
 // #fftControl is shared by iq and spec; park it in whichever of the two panels is showing.
 if(captureMode==='iq'||isSpec()){const options=$(isSpec()?'specOptions':'iqControls');if($('fftControl').parentElement!==options)options.prepend($('fftControl'));}
 $('specRow').disabled=!canSpec||!isSpec()||busy;$('specDetector').disabled=$('specRow').disabled;
 if(connected&&isSpec())$('bits').disabled=true;
 $('fft8192').hidden=$('fft16384').hidden=!radio.hasBigcap; // BIGCAP long snapshots, IQ mode
 {const specOn=connected&&isSpec();
  for(const o of $('rate').options){o.disabled=specOn&&!radio.spectrumProfiles(Number(o.value)).length;o.hidden=o.disabled;}
  if(specOn&&!radio.spectrumProfiles(Number($('rate').value)).length)$('rate').value=String(radio.specCapabilities.profiles[0][0]);
  const iqSizes=radio.hasBigcap?[512,1024,2048,4096,8192,16384]:[512,1024,2048,4096];
  const sizes=specOn?specSizes(Number($('rate').value)):iqSizes;
  for(const o of $('fft').options){o.disabled=!sizes.includes(Number(o.value));o.hidden=o.disabled;}
  $('specNote').hidden=!specOn;
  $('specNote').textContent=radio.spectrumContinuous(Number($('rate').value),Number($('fft').value))
   ?'Continuous RF capture; only selected FFT windows are analyzed. Skipped work and dropped frames are reported.'
   :'On-chip FFT of repeated snapshots. Reception has gaps between snapshots.';
  if(!sizes.includes(Number($('fft').value)))$('fft').value=String(specOn?sizes[sizes.length-1]:2048);}
 $('deviceModel').textContent=connected?(radio.deviceName||'ESP32-'+radio.family):'';$('deviceModel').hidden=!connected;$('chipIdentity').hidden=!connected;
 $('status').textContent=connected?(paused?'Paused':'Receiving'):'Disconnected';
 $('connect').textContent=connected?'Disconnect':'Connect ESP-SDR';$('light').classList.toggle('on',connected&&!paused);
 $('pause').disabled=!connected||(!!radio.changingBaud||!!radio.changingGpio);$('pause').textContent=paused?'Resume':'Pause';
 $('calFromPeak').disabled=!connected||(!!radio.changingBaud||!!radio.changingGpio);
 
 for(const b of document.querySelectorAll('[data-freq]'))b.disabled=!connected||(!!radio.changingBaud||!!radio.changingGpio)||(+b.dataset.freq===5500&&radio.family!=='C5')||!radio.validFrequency(+b.dataset.freq);
 const gainDisabled=!connected||(!!radio.changingBaud||!!radio.changingGpio)||!radio.hasGain;
 $('gainAgc').disabled=gainDisabled||!radio.hasHardwareAgc;$('gainManual').disabled=gainDisabled;
 $('gainAgc').setAttribute('aria-pressed',String(gainMode==='HARDWARE'));$('gainManual').setAttribute('aria-pressed',String(gainMode==='MANUAL'));
 $('gain').disabled=!connected||(!!radio.changingBaud||!!radio.changingGpio)||gainMode!=='MANUAL'||!radio.hasGain;
 const bandwidthDisabled=!connected||(!!radio.changingBaud||!!radio.changingGpio)||!radio.bandwidthRange;
 $('bandwidthOpen').disabled=bandwidthDisabled;$('bandwidthFilter').disabled=bandwidthDisabled;
 $('bandwidthOpen').setAttribute('aria-pressed',String(analogBandwidth===0));$('bandwidthFilter').setAttribute('aria-pressed',String(analogBandwidth!==0));
 $('bandwidth').disabled=bandwidthDisabled||analogBandwidth===0;
 dbg.stat();
}
let dismissedTuningFrequency=null;
function tuningWarning(){
 const warning=connected?radio.frequencyWarning(tuneFrequency):'';
 if(!warning)dismissedTuningFrequency=null;
 $('tuningWarningText').textContent=warning;
 $('tuningWarning').hidden=!warning||dismissedTuningFrequency===tuneFrequency;
 $('frequency').classList.toggle('offband',!!warning);$('frequency').title=warning;
}
$('dismissTuningWarning').onclick=()=>{dismissedTuningFrequency=tuneFrequency;tuningWarning();};
let dismissedFirmwareVersion=null;
function firmwareWarning(){
 const version=radio.firmwareVersion,panel=$('firmwareWarning');
 if(!connected)dismissedFirmwareVersion=null;
 panel.hidden=!connected||!version||version===dismissedFirmwareVersion;
 $('deviceModel').title=connected&&version?.status==='known'?`Firmware: ${version.revision}\nBuilt: ${version.build_timestamp}`:'';
 if(panel.hidden)return;
 const result=version.status==='missing'
  ?{status:'outdated',message:'This firmware does not report its version. Update the firmware to the latest build.'}
  :firmwareUpdate;
 panel.hidden=result?.status!=='outdated';
 $('firmwareWarningText').textContent=result?.message||'';
}
$('dismissFirmwareWarning').onclick=()=>{dismissedFirmwareVersion=radio.firmwareVersion;firmwareWarning();};
async function checkFirmwareUpdate(){
 const check=++firmwareCheck,installed=radio.firmwareVersion;
 firmwareUpdate=null;firmwareWarning();
 if(!installed||installed.status==='missing')return;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
 let result;
 try{
  const response=await fetch('firmware/manifest.json',{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw Error('Firmware catalog unavailable');
  result=firmwareUpdateStatus(installed,await response.json());
 }catch{result={status:'unknown',message:'Firmware update check unavailable.'};}
 finally{clearTimeout(timeout);}
 // An old connection's request must never update a newly connected device.
 if(check!==firmwareCheck||!connected||radio.firmwareVersion!==installed)return;
 firmwareUpdate=result;firmwareWarning();
}
function updateGpioControls(){
 const panel=$('gpioControls');panel.hidden=!connected||!radio.hasGpio;
 if(panel.hidden)return;
 const list=$('gpioPins'),pins=radio.gpioPins;
 const signature=pins.map(p=>p.pin).join(',');
 if(list.dataset.pins!==signature){
  list.replaceChildren();list.dataset.pins=signature;
  for(const {pin} of pins){
   const row=document.createElement('div');row.className='gpio-row';
   const label=document.createElement('span');label.id=`gpioLabel${pin}`;label.textContent=`GPIO ${pin}`;
   const buttons=document.createElement('div');buttons.className='gain-modes gpio-modes';
   buttons.setAttribute('role','group');buttons.setAttribute('aria-labelledby',label.id);
   for(const value of ['Z','0','1']){
    const button=document.createElement('button');button.type='button';button.textContent=value;
    button.dataset.pin=String(pin);button.dataset.state=value;
    button.title=value==='Z'?'High impedance (no pulls)':value==='0'?'Drive low':'Drive high';
    button.onclick=()=>changeGpio(pin,value);buttons.append(button);
   }
   row.append(label,buttons);list.append(row);
  }
 }
 for(const button of list.querySelectorAll('button')){
  const entry=pins.find(p=>p.pin===Number(button.dataset.pin));
  button.setAttribute('aria-pressed',String(entry.state===button.dataset.state));
  button.disabled=connectionBusy||!!radio.changingBaud||!!radio.changingGpio;
 }
 $('gpioEmpty').hidden=pins.length!==0;
}
async function changeGpio(pin,value){
 if(!connected||connectionBusy||radio.changingBaud||radio.changingGpio)return;
 const wasPaused=paused;let succeeded=false;paused=true;radio.changingGpio=true;state();
 try{
  // Let the current burst finish, or stop/drain a spectrum stream, before
  // issuing a text command. Keep the acknowledged selection until success.
  await loopDone;
  if(!connected||radio.failed)throw radio.failed||Error('Disconnected');
  await radio.setGpio(pin,value);
  clear();error('');succeeded=true;
 }catch(e){
  if(radio.failed){connected=false;await radio.run(()=>radio.close()).catch(()=>{});}
  error(e);
 }
 finally{
  radio.changingGpio=false;paused=succeeded?wasPaused:true;previous=0;state();
  if(connected&&!paused)loop();
 }
}
function bandwidthChanged(){if($('bandwidth').disabled)return;if(!$('bandwidth').checkValidity()){$('bandwidth').reportValidity();return;}analogBandwidth=Number($('bandwidth').value);state();clear();}
$('bandwidthOpen').onclick=()=>{if($('bandwidthOpen').disabled||analogBandwidth===0)return;$('bandwidth').value=analogBandwidth;analogBandwidth=0;state();clear();};
$('bandwidthFilter').onclick=()=>{if($('bandwidthFilter').disabled||analogBandwidth!==0)return;$('bandwidth').disabled=false;bandwidthChanged();};
$('bandwidth').onchange=bandwidthChanged;
$('bandwidth').closest('label').addEventListener('wheel',e=>{
 const input=$('bandwidth');if(input.disabled||!e.deltaY||e.ctrlKey)return;
 e.preventDefault();const previous=input.value;
 if(e.deltaY<0)input.stepUp();else input.stepDown();
 if(input.value!==previous)bandwidthChanged();
},{passive:false});
$('gainAgc').onclick=()=>{if($('gainAgc').disabled)return;gainMode='HARDWARE';state();clear();};
$('gainManual').onclick=()=>{if($('gainManual').disabled)return;gainMode='MANUAL';state();clear();};
$('gain').oninput=()=>{$('gainValue').textContent=`${$('gain').value} / ${radio.gainMax}`;clear();};
radio.onCaptureError=serialWarning;
$('lowerBaud').onclick=async()=>{
 if(!connected||radio.changingBaud||radio.changingGpio)return;
 paused=true;radio.changingBaud=true;state();
 try{
  await radio.setBaudRate(1000000);
  checkFirmwareUpdate();
  paused=false;previous=0;latest=null;clear();error('');
 }catch(e){connected=!!radio.port&&!radio.failed;error(e,!connected);}
 finally{radio.changingBaud=false;state();if(connected&&!paused)loop();}
};
// Reuse a previously granted port only when its USB identity is unambiguous.
// The picker includes UART bridges as well as native USB boards.
const PORT_KEY='espSdrPort';
function savedPort(){try{return JSON.parse(localStorage.getItem(PORT_KEY)||'null');}catch(e){return null;}}
function rememberPort(p){try{const i=p.getInfo?.()||{};if(i.usbVendorId)localStorage.setItem(PORT_KEY,JSON.stringify({vid:i.usbVendorId,pid:i.usbProductId,kind:SerialConnection.kind(p)}));}catch(e){}}
async function choosePort(ev){
 if(!SerialConnection.supported())throw Error('WebSerial or WebUSB support is required in this browser.');
 if(!ev?.choosePort){const saved=savedPort();
  // Prefer an already-granted WebUSB device: it exposes the chip serial (MAC)
  // used to key per-board profiles. Never force a WebUSB picker that could fail
  // to claim the port (e.g. a desktop OS driver owns the CDC interface).
  if(navigator.usb){const usb=await SerialConnection.getPorts('webusb');
   const u=saved?usb.filter(p=>{const i=p.getInfo?.()||{};return i.usbVendorId===saved.vid&&i.usbProductId===saved.pid;}):usb;
   if(u.length===1)return u[0];}
  const ports=await SerialConnection.getPorts(saved?.kind);
  const matches=saved?ports.filter(p=>{const i=p.getInfo?.()||{};return i.usbVendorId===saved.vid&&i.usbProductId===saved.pid;}):[];
  if(matches.length===1)return matches[0];if(ev?.auto)return null;}
 return SerialConnection.requestPort(ev?.kind);
}
$('connect').title='Connect to the remembered port';
function closeConnectMenu(focus=false){$('connectMenu').hidden=true;$('choosePort').setAttribute('aria-expanded','false');if(focus)$('choosePort').focus();}
function openConnectMenu(){state();$('connectMenu').hidden=false;$('choosePort').setAttribute('aria-expanded','true');$('connectMenu').querySelector('button:not(:disabled),a').focus();}
$('choosePort').onclick=()=>{$('connectMenu').hidden?openConnectMenu():closeConnectMenu(true);};
$('choosePort').onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();openConnectMenu();}};
$('openRecent').onclick=()=>{closeConnectMenu(true);return $('connect').onclick();};
$('openOther').onclick=()=>{closeConnectMenu(true);return $('connect').onclick({choosePort:true,kind:'webserial'});};
$('openUSB').onclick=()=>{closeConnectMenu(true);return $('connect').onclick({choosePort:true,kind:'webusb'});};
$('toggleGapFill').onclick=()=>{closeConnectMenu(true);return radioB?disconnectB():connectB();};
$('openFlasher').onclick=openFirmwareInstaller;
$('updateFirmware').onclick=openFirmwareInstaller;
$('connectMenu').onkeydown=e=>{
 if(e.key==='Escape'){e.preventDefault();closeConnectMenu(true);}
 else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
  e.preventDefault();const items=Array.from($('connectMenu').querySelectorAll('button:not(:disabled),a')),at=items.indexOf(document.activeElement);
  items[e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
 }
};
document.addEventListener('click',e=>{if(!e.target.closest('.connect-buttons'))closeConnectMenu();});
document.addEventListener('focusin',e=>{if(!e.target.closest('.connect-buttons'))closeConnectMenu();});
async function disconnectRadio(){
 connected=false;state();
 const done=api('disconnect',{});let timer;
 try{
  const timedOut=await Promise.race([done.then(()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(true),2000);})]);
  if(timedOut){await radio.closePort();await done.catch(()=>{});}
 }finally{clearTimeout(timer);}
}
async function openFirmwareInstaller(event){
 event.preventDefault();closeConnectMenu(true);
 if(connectionBusy||radio.changingBaud||radio.changingGpio){error('Wait for the current device operation to finish, then open the firmware installer again.');return;}
 const url=event.currentTarget.href;
 connectionBusy=true;firmwareHandoff=true;
 let installer;
 try{
  // Open a blank tab during the click, then load the installer only after USB is free.
  installer=window.open('about:blank','_blank');
  if(installer)installer.opener=null;
  if(connected||radio.port)await disconnectRadio();
  if(installer&&!installer.closed)installer.location.replace(url);
  else window.location.assign(url);
 }catch(e){installer?.close();firmwareHandoff=false;error(e);}
 finally{connectionBusy=false;state();}
}
$('connect').onclick=async(ev)=>{closeConnectMenu();if(connectionBusy||radio.changingBaud||radio.changingGpio||(ev?.auto&&(connected||firmwareHandoff)))return;if(!ev?.auto)firmwareHandoff=false;connectionBusy=true;state();try{if(connected){if(radioB)await disconnectB();await disconnectRadio();currentBoardKey=null;const pb=$('profileBox');if(pb)pb.hidden=true;}else{const port=await choosePort(ev);if(!port)return;await api('connect',{port});rememberPort(port);connected=true;checkFirmwareUpdate();captureMode=radio.canStreamSpectrum?'spec':'iq';applyRadioProfile();loadProfile();refreshDiag(true);paused=false;previous=0;latest=null;clear();loop();}error('');}catch(e){error(e,!['NotFoundError','AbortError'].includes(e?.name));}finally{connectionBusy=false;state();}};
$('pause').onclick=()=>{paused=!paused;previous=0;state();if(!paused){error('');loop();}};$('clear').onclick=clear;
for(const id of ['rate','bits','fft'])$(id).onchange=()=>{state();labels();};
$('frequency').onchange=()=>{tuneFrequency=Number($('frequency').value);labels();};
$('frequency').onkeydown=e=>{if(e.key==='Enter')$('frequency').blur();};
$('frequency').closest('label').addEventListener('wheel',e=>{
 const input=$('frequency');if(input.disabled||!e.deltaY||e.ctrlKey)return;
 e.preventDefault();
 const value=Number(input.value),current=input.value!==''&&Number.isFinite(value)?value:tuneFrequency;
 tuneFrequency=radio.nearestFrequency(Math.round(current)-Math.sign(e.deltaY));
 input.value=tuneFrequency;labels();
},{passive:false});
for(const b of document.querySelectorAll('[data-freq]'))b.onclick=()=>{$('frequency').value=b.dataset.freq;tuneFrequency=Number(b.dataset.freq);labels();};
for(const id of ['floor','range'])$(id).oninput=()=>{$('floorValue').textContent=$('floor').value+' dBFS';$('rangeValue').textContent=$('range').value+' dB';$('scale').textContent=`${$('floor').value} → ${Number($('floor').value)+Number($('range').value)} dBFS`;redrawWater();draw();};
$('hold').onchange=()=>{maximum=null;draw();};
for(const key of ['wifi24','wifi5','ble','bt','waterfall']){const el=$('mark'+key[0].toUpperCase()+key.slice(1));el.checked=markerPrefs[key];el.onchange=()=>{markerPrefs[key]=el.checked;try{localStorage.setItem('espSdrMarkers',JSON.stringify(markerPrefs));}catch(e){}draw();labels();};}
// ---- frequency calibration (ppm) assistant ---------------------------------
function fmtPpm(){if(!freqCal)return 'Calibration off';const hz=2440e6*freqCal/1e6;return `${freqCal>0?'+':''}${freqCal.toFixed(1)} ppm (${hz>=0?'+':'−'}${Math.abs(hz/1e3).toFixed(1)} kHz @ 2.44 GHz)`;}
function applyCal(ppm){freqCal=Math.max(-500,Math.min(500,Number(ppm)||0));try{localStorage.setItem('espSdrFreqCal',String(freqCal));}catch(e){}$('calPpm').value=freqCal;$('calStatus').textContent=fmtPpm();draw();labels();}
function calPickOff(){calPicking=false;$('calPick').setAttribute('aria-pressed','false');$('calPick').textContent='Pick on graph';}
// Observed frequency must be the uncalibrated (nominal) value to yield absolute ppm.
function calGrab(hz){calObservedHz=hz;$('calObserved').textContent=(hz/1e6).toFixed(4)+' MHz';$('calForm').hidden=false;if(!$('calTrue').value)$('calTrue').value=(hz*freqFactor()/1e6).toFixed(3);}
$('calPpm').value=freqCal;$('calStatus').textContent=fmtPpm();
$('calPpm').onchange=()=>{const v=Number($('calPpm').value);if(Number.isFinite(v))applyCal(v);};
$('calReset').onclick=()=>{$('calForm').hidden=true;calPickOff();applyCal(0);};
$('calFromPeak').onclick=()=>{if(peakHzNominal==null){error('No peak yet — connect and wait for a live signal.');return;}calGrab(peakHzNominal);};
$('calApply').onclick=()=>{const trueMHz=Number($('calTrue').value);if(!Number.isFinite(trueMHz)||trueMHz<=0||!calObservedHz){error('Enter the reference true frequency in MHz.');return;}applyCal((trueMHz*1e6/calObservedHz-1)*1e6);$('calForm').hidden=true;calPickOff();error('');};
$('calPick').onclick=()=>{calPicking=!calPicking;$('calPick').setAttribute('aria-pressed',String(calPicking));$('calPick').textContent=calPicking?'Click the peak on the graph…':'Pick on graph';};
// ---- per-board configuration profiles --------------------------------------
// Keyed by the native-USB serial number (the chip MAC, WebUSB only) when
// available, otherwise by chip model. Settings auto-save (debounced) on any
// aside interaction and reload when a known board connects.
function boardKey(){const sn=radio.port&&radio.port.device&&radio.port.device.serialNumber;return sn?'sn:'+sn:'model:'+(radio.family||'?');}
function readProfiles(){try{const v=JSON.parse(localStorage.getItem('espSdrProfiles')||'{}');return v&&typeof v==='object'?v:{};}catch(e){return {};}}
function collectProfile(){return {freqCal,markers:{...markerPrefs},
 display:{floor:$('floor').value,range:$('range').value,average:$('average').value,hold:$('hold').checked,autoscale:$('autoscale').checked},
 capture:{mode:captureMode,specRow:$('specRow').value,specDetector:$('specDetector').value,
  cspecFft:$('cspecFft').value,cspecDetector:$('cspecDetector').value,cspecNavg:$('cspecNavg').value,
  sweepF0:$('sweepF0').value,sweepF1:$('sweepF1').value,sweepStep:$('sweepStep').value,sweepFft:$('sweepFft').value,sweepNavg:$('sweepNavg').value},
 radio:{frequency:tuneFrequency,rate:$('rate').value,fft:$('fft').value,bits:$('bits').value,gainMode,gain:$('gain').value,bandwidth:analogBandwidth}};}
function saveProfile(){if(!currentBoardKey)return;const all=readProfiles();all[currentBoardKey]=collectProfile();try{localStorage.setItem('espSdrProfiles',JSON.stringify(all));}catch(e){}}
function markDirty(){if(loadingProfile||!connected||!currentBoardKey)return;clearTimeout(saveTimer);saveTimer=setTimeout(saveProfile,500);}
function updateProfileLabel(){const box=$('profileBox');if(!box)return;box.hidden=!connected||!currentBoardKey;if(box.hidden)return;
 const name=radio.deviceName||('ESP32-'+radio.family);
 $('profileKey').textContent=currentBoardKey.startsWith('sn:')?`${currentBoardKey.slice(3)} · ${name}`:`${name} · model-wide`;}
function loadProfile(){
 currentBoardKey=boardKey();updateProfileLabel();
 const p=readProfiles()[currentBoardKey];
 if(!p)return;  // first time for this board: keep chip defaults, saved on first change
 loadingProfile=true;
 try{
  if(typeof p.freqCal==='number')applyCal(p.freqCal);
  if(p.markers&&typeof p.markers==='object')for(const k of ['wifi24','wifi5','ble','bt','waterfall'])if(typeof p.markers[k]==='boolean'){markerPrefs[k]=p.markers[k];const el=$('mark'+k[0].toUpperCase()+k.slice(1));if(el)el.checked=p.markers[k];}
  const d=p.display||{};
  if(d.floor!==undefined){$('floor').value=d.floor;$('floorValue').textContent=$('floor').value+' dBFS';}
  if(d.range!==undefined){$('range').value=d.range;$('rangeValue').textContent=$('range').value+' dB';}
  if(d.average!==undefined)$('average').value=d.average;
  if(typeof d.hold==='boolean')$('hold').checked=d.hold;
  if(typeof d.autoscale==='boolean')$('autoscale').checked=d.autoscale;
  const cap=p.capture||{};
  const modeOk=m=>m==='iq'||(m==='spec'&&radio.canStreamSpectrum)||(m==='cspec'&&radio.hasCspec)||(m==='sweep'&&radio.hasSweep);
  if(typeof cap.mode==='string'&&modeOk(cap.mode))captureMode=cap.mode;
  else if(typeof cap.mode==='boolean')captureMode=cap.mode&&radio.canStreamSpectrum?'spec':'iq';
  const setSel=(id,v)=>{if(v!==undefined&&[...$(id).options].some(o=>o.value===String(v)))$(id).value=String(v);};
  setSel('cspecFft',cap.cspecFft);setSel('cspecDetector',cap.cspecDetector);setSel('cspecNavg',cap.cspecNavg);
  setSel('sweepFft',cap.sweepFft);setSel('sweepNavg',cap.sweepNavg);
  for(const [id,v] of [['sweepF0',cap.sweepF0],['sweepF1',cap.sweepF1],['sweepStep',cap.sweepStep]])if(Number.isFinite(Number(v))&&v!=='')$(id).value=String(Number(v));
  if(cap.specRow!==undefined&&[...$('specRow').options].some(o=>o.value===String(cap.specRow)))$('specRow').value=String(cap.specRow);
  if(cap.specDetector!==undefined&&[...$('specDetector').options].some(o=>o.value===String(cap.specDetector)))$('specDetector').value=String(cap.specDetector);
  const r=p.radio||{};
  if(Number.isInteger(r.frequency)&&radio.validFrequency(r.frequency)){tuneFrequency=r.frequency;$('frequency').value=r.frequency;}
  if(r.rate!==undefined&&radio.rxRates.includes(Number(r.rate)))$('rate').value=String(Number(r.rate));
  if(r.bits!==undefined&&radio.sampleBits.includes(Number(r.bits)))$('bits').value=String(Number(r.bits));
  if(r.fft!==undefined&&[256,512,1024,2048,4096,8192,16384].includes(Number(r.fft))&&(Number(r.fft)<=4096||radio.hasBigcap))$('fft').value=String(Number(r.fft));
  if(r.gainMode==='MANUAL'||(r.gainMode==='HARDWARE'&&radio.hasHardwareAgc))gainMode=r.gainMode;
  if(r.gain!==undefined&&Number(r.gain)>=radio.gainMin&&Number(r.gain)<=radio.gainMax){$('gain').value=r.gain;$('gainValue').textContent=`${$('gain').value} / ${radio.gainMax}`;}
  const b=radio.bandwidthRange;
  if(r.bandwidth!==undefined&&(Number(r.bandwidth)===0||(b&&Number(r.bandwidth)>=b[0]&&Number(r.bandwidth)<=b[1]))){analogBandwidth=Number(r.bandwidth);if(b)$('bandwidth').value=analogBandwidth||b[1];}
  $('scale').textContent=`${Number($('floor').value)} → ${Number($('floor').value)+Number($('range').value)} dBFS`;
 }finally{loadingProfile=false;}
 redrawWater();draw();labels();
}
$('profileForget').onclick=()=>{if(!currentBoardKey)return;const all=readProfiles();delete all[currentBoardKey];try{localStorage.setItem('espSdrProfiles',JSON.stringify(all));}catch(e){}};
{const aside=document.querySelector('aside');if(aside)for(const ev of ['change','input','click'])aside.addEventListener(ev,markDirty);}
// ---- controls panel (left column) collapse --------------------------------
// The toggle lives in the header (outside the aside) so it doesn't trip markDirty.
{const main=document.querySelector('main'),tgl=$('toggleControls');
 const setControls=open=>{main.classList.toggle('collapsed',!open);tgl.setAttribute('aria-expanded',open?'true':'false');try{localStorage.setItem('espSdrControlsOpen',open?'1':'0');}catch(e){}};
 // Restore the collapsed state without animating (else the panel flashes open->shut on every reload).
 try{if(localStorage.getItem('espSdrControlsOpen')==='0'){main.style.transition='none';setControls(false);requestAnimationFrame(()=>{main.style.transition='';});}}catch(e){}
 tgl.onclick=()=>setControls(main.classList.contains('collapsed'));}
// ---- shrinkable header ----------------------------------------------------
{const root=document.documentElement,tgl=$('toggleHeader');
 const setHeader=min=>{root.classList.toggle('header-min',min);tgl.setAttribute('aria-expanded',min?'false':'true');try{localStorage.setItem('espSdrHeaderMin',min?'1':'0');}catch(e){}};
 try{if(localStorage.getItem('espSdrHeaderMin')==='1')setHeader(true);}catch(e){}
 tgl.onclick=()=>setHeader(!root.classList.contains('header-min'));}
// ---- debug / UART panel toggle (right column, collapsed by default) -------
{const main=document.querySelector('main'),tgl=$('toggleDebug');
 const setDebug=on=>{main.classList.toggle('debug-open',on);tgl.setAttribute('aria-expanded',on?'true':'false');dbg.setOpen(on);try{localStorage.setItem('espSdrDebugOpen',on?'1':'0');}catch(e){}};
 try{if(localStorage.getItem('espSdrDebugOpen')==='1'){main.style.transition='none';setDebug(true);requestAnimationFrame(()=>{main.style.transition='';});}}catch(e){}
 tgl.onclick=()=>setDebug(!main.classList.contains('debug-open'));
 $('debugClear').onclick=()=>dbg.clear();}
spec.onmousemove=e=>{if(!latest)return;const x=viewFrac(e.clientX,spec),i=Math.max(0,Math.min(latest.fft-1,Math.floor(x*latest.fft)));$('cursor').textContent=`${((latest.frequency*1e6+(x-.5)*latest.rate)*freqFactor()/1e6).toFixed(5)} MHz · ${latest.spectrum[i].toFixed(1)} dBFS`;};
function queueTune(e,el){if(suppressClick){suppressClick=false;return;}if(e.detail>1)return;/* calibration pick mode: grab the observed (nominal) frequency instead of tuning */if(calPicking&&latest){calPickOff();calGrab(latest.frequency*1e6+(viewFrac(e.clientX,el)-.5)*latest.rate);return;}clearTimeout(tuneClick);const x=e.clientX;tuneClick=setTimeout(()=>{if(connected&&latest){tuneFrequency=radio.nearestFrequency(latest.frequency+(viewFrac(x,el)-.5)*latest.rate/1e6);$('frequency').value=tuneFrequency;labels();}},250);}
spec.onclick=e=>queueTune(e,spec);
water.onclick=e=>queueTune(e,water);$('axisCanvas').onclick=e=>queueTune(e,$('axisCanvas'));
// Coalesce resizes (window + panel-collapse animation) onto one frame:
// resize() clears then repaints the waterfall, so firing it every frame makes it flicker.
let roRaf=0;new ResizeObserver(()=>{if(roRaf)return;roRaf=requestAnimationFrame(()=>{roRaf=0;resize();});}).observe(spec);labels();state();

// Keep a frame-selection boundary for future signal-based triggering.
function selectRxFrame(f){
 return f.frequency===loFrequency()&&f.rate===Number($('rate').value)&&
  (!f.trigger||f.trigger.mode==='free');
}

// Firmware-computed spectrum stream.
let specPending=[],specLast=null,specRAF=0,specCount=[],specInfo=null,autoT=0,waterMap=null,lut32=null;
let cspecPending=[],cspecRAF=0,cspecCount=[];
// Firmware bins are |FFT(I+jQ)|^2 in FFT order; this app displays conj(I+jQ)
// (see capture(): q is negated), so web bin j holds firmware bin (n/2-j) mod n.
// code/step = 10log10|X|^2 with X = FFT(IQ10*64*hann)/n; 84.3 dB maps that to
// the dBFS scale of spectrum() (full scale 512, Hann power normalization), for any n.
// Code 0 includes below-floor powers; display it at the nominal encoding floor.
function specToDbfs(bins,step,n){const out=new Float32Array(n);for(let j=0;j<n;j++){const v=bins[(n/2-j+n)%n];out[j]=v/step-84.3;}
 // zero-IF DC offset / LO leakage (35-45 dB over the floor, VSG60 test): bridge DC +-1 bin
 if($('dcMode').value==='fill'){const c=n/2,m=10*Math.log10((10**(out[c-2]/10)+10**(out[c+2]/10))/2);out[c-1]=out[c]=out[c+1]=m;}return out;}
function specSizes(rate){return radio.spectrumProfiles(rate).map(p=>p[2]);}
function specDisplayKey(c){return ['spec',c.rate,c.fft,c.frequency,c.bandwidth,c.gainMode,c.gain,c.maxHold,$('dcMode').value,$('specRow').value].join('/');}
function specConfig(){
 const c=config(),profiles=radio.spectrumProfiles(c.rate);
 const profile=profiles.find(p=>p[2]===c.fft)||profiles[0];
 if(!profile)return {...c,stride:1,upf:1};
 const [rate,,fft,stride,upf0]=profile;
 // S3/S31 continuous: one bank unit is 12288 pairs (0.77 ms at 16 MS/s). ~2 frames per
 // waterfall row are enough; the chip merges the rest (far less dB coding/CRC/USB work).
 const unitMs=12288e3/rate,rowMs=Number($('specRow').value)||0;
 const upf=['S3','S31'].includes(radio.family)&&radio.spectrumContinuous(rate,fft)?Math.min(1000,Math.max(upf0,Math.floor(rowMs/unitMs/2))):upf0;
 return {...c,rate,fft,bits:10,stride,upf,maxHold:$('specDetector').value==='max'};
}
async function specLoop(){
 specPending=[];specLast=null;specCount=[];specCov=null;
 const c=specConfig(),n=c.fft,rowMs=Number($('specRow').value),agg=new SpectrumAccumulator(n,c.maxHold),dcMode=$('dcMode').value;let aggT=0;
 const displayKey=specDisplayKey(c),queueRow=()=>{const row=agg.finish();if(row){row.key=displayKey;specPending.push(row);}};
 const changed=()=>{const m=specConfig();return $('dcMode').value!==dcMode||m.frequency!==c.frequency||m.gainMode!==c.gainMode||m.gain!==c.gain||m.bandwidth!==c.bandwidth||m.maxHold!==c.maxHold||m.rate!==c.rate||m.fft!==c.fft||Number($('specRow').value)!==rowMs;};
 if(!specRAF)specRAF=requestAnimationFrame(specFrame);
 specInfo=await radio.spec(c,(h,bins,info)=>{
  if(changed())return;
  specInfo=info;if(info.stats)specCov=info.stats.coverage/100;else if(h.pairs&&radio.spectrumContinuous(c.rate,n))specCov=h.ffts*n/h.pairs;else specCov=null;const s=specToDbfs(bins,h.step,n);
  if(!agg.weight)aggT=h.t;
  agg.add(s,h.ffts);
  specLast=h;specCount.push(performance.now());
  // A frame's timestamp is its start, not its end. Include its sample span.
  if(agg.weight&&h.t+h.pairs/c.rate-aggT>=rowMs/1000)queueRow();
  // hidden tab: no animation frames, so bound the backlog here
  if(specPending.length>1024)specPending.splice(0,specPending.length-512);
  if(specCount.length>4096){const t=performance.now()-1000;let i=0;while(i<specCount.length&&specCount[i]<t)i++;specCount.splice(0,i);}
 },()=>!connected||paused||!isSpec()||dualActive()||changed());
 if(!changed()&&isSpec()){queueRow();if(specPending.length&&!specRAF)specRAF=requestAnimationFrame(specFrame);}
}
function specFrame(){specRAF=0;if(specPending.length){const rows=specPending;specPending=[];renderSpec(rows);}if(connected&&!paused&&isSpec()&&!dualActive())specRAF=requestAnimationFrame(specFrame);}
function renderSpec(rows){
 const c=specConfig(),k=specDisplayKey(c);
 rows=rows.filter(row=>row.key===k);
 if(!isSpec()||!rows.length)return;
 const nb=rows[0].bins.length;
 if(key!==k){key=k;clear();}
 const batch=new SpectrumAccumulator(nb,c.maxHold);
 for(const r of rows)batch.add(r.bins,r.weight);
 const cur=batch.finish().bins;
 const a=Number($('average').value);
 if(trace&&trace.length!==nb){trace=null;maximum=null;}
 trace=Array.from(cur,(v,i)=>trace?10*Math.log10(a*10**(trace[i]/10)+(1-a)*10**(v/10)):v);
 // Preserve brief peaks even when several spectra/rows arrive in one paint.
 if(!maximum)maximum=Array(nb).fill(-Infinity);
 for(const r of rows)for(let i=0;i<nb;i++)maximum[i]=Math.max(maximum[i],r.peak[i]);
 latest={frequency:c.frequency,rate:c.rate,fft:nb,spectrum:trace};draw();
 const n=Math.min(rows.length,water.height),floor=Number($('floor').value),range=Number($('range').value),W=water.width;
 wc.drawImage(water,0,0,W,water.height-n,0,n,W,water.height-n);
 // one pixel column = max of the bins it covers in the current view
 const newest=[];for(let r=0;r<n;r++)newest.push(rows[rows.length-1-r].bins);pushWater(newest);paintRows(newest,0);
 autoScale(trace);
 let peak=0;for(let j=1;j<nb;j++)if(cur[j]>cur[peak])peak=j;
 const now=performance.now();while(specCount.length&&specCount[0]<now-1000)specCount.shift();
 $('empty').hidden=true;labels(c);
 $('fps').textContent=`${specCount.length}`;$('fpsLabel').textContent='spectra/s';
 {const st=specInfo&&specInfo.stats,el=$('chipStats');el.hidden=!st||performance.now()-st.t>3000;if(!el.hidden)el.textContent=`Core 0: ${st.core0.toFixed(0)} % · Core 1: ${st.dual?st.core1.toFixed(0)+' %':'off'}\nFFT coverage: ${st.coverage.toFixed(1)} % (${(st.fftsPerS/1e3).toFixed(1)} k/s)\nRAM free: ${(st.heapFree/1024).toFixed(0)} KB · Largest block: ${(st.heapLargest/1024).toFixed(0)} KB\nMax lateness: ${st.lateMax} · Skipped: ${st.abandoned}\nQueue: ${st.queue.toFixed(0)} %`;}
 $('throughput').textContent=(specCount.length*(32+nb)/1e3).toFixed(0);$('throughputLabel').textContent=`kB/s over ${radio.transport} · ${c.rate/1e6} MS/s on chip${specCov===null?'':` · FFT on ${Math.round(specCov*100)} % of samples`}`;
 $('latency').textContent=specLast?(specLast.pairs/c.rate*1e3).toFixed(2):'—';$('latencyLabel').textContent=`ms / spectrum · ${c.maxHold?'max':'mean'} of ${specLast?.ffts??'—'} FFT`;
 {const pk=c.frequency*1e6+(peak-nb/2)*c.rate/nb;peakHzNominal=pk;$('peak').textContent=(pk*(typeof freqFactor==='function'?freqFactor():1)/1e6).toFixed(4);}
 const g=specInfo?.gain;$('gainStatus').textContent=(g?.mode==='HARDWARE'?'Hardware AGC':g?`Manual · index ${g.index}`:'');
 $('crc').textContent=`SPEC · ${radio.spectrumContinuous(Number($('rate').value),Number($('fft').value))?'continuous capture':'snapshots with gaps'} · #${specLast?.frame??0}${specLast?.drops?` · ${specLast.drops} dropped`:''}${specInfo?.crcErrors?` · ${specInfo.crcErrors} CRC err`:''}${specInfo?.hostDropped?` · ${Math.round(specInfo.hostDropped/1024)} kB skipped (page busy)`:''}`;
}
// ---- ESPsoup continuous waterfall (CSPEC) ----------------------------------
// Each SPL line (u8, host order -fs/2..+fs/2, DC centred) becomes a waterfall row.
function cspecConfig(){
 const nfft=Number($('cspecFft').value),navg=Number($('cspecNavg').value)||8,stride=1;
 if(!(nfft>=16&&nfft<=256)||nfft*navg*stride>8192)return null;
 return {frequency:loFrequency(),rate:Number($('rate').value),bandwidth:analogBandwidth,nfft,navg,stride,
  mode:$('cspecDetector').value==='mean'?0:1,gainMode,gain:Number($('gain').value)};
}
async function cspecLoop(){
 const c=cspecConfig();
 if(!c){await new Promise(r=>setTimeout(r,200));return;}
 const changed=()=>{const m=cspecConfig();return !m||m.frequency!==c.frequency||m.rate!==c.rate||m.nfft!==c.nfft||m.navg!==c.navg||m.mode!==c.mode||m.gainMode!==c.gainMode||m.gain!==c.gain;};
 if(!cspecRAF)cspecRAF=requestAnimationFrame(cspecFrame);
 await radio.cspec(c,(line,meta)=>{
  if(changed())return;
  const nfft=meta.nfft,sh=meta.sh,disp=new Float32Array(nfft);
  // u8 = 2*10*log10(|X|^2)+12*sh -> approx dBFS (arbitrary reference, display-only)
  for(let j=0;j<nfft;j++)disp[j]=(line[j]-12*sh)/2-128;
  cspecPending.push(disp);
  if(cspecPending.length>2048)cspecPending.splice(0,cspecPending.length-512);
 },()=>!connected||paused||!isCspec()||dualActive()||changed());
}
function cspecFrame(){cspecRAF=0;if(cspecPending.length){const rows=cspecPending;cspecPending=[];renderCspec(rows);}if(connected&&!paused&&isCspec()&&!dualActive())cspecRAF=requestAnimationFrame(cspecFrame);}
function renderCspec(rows){
 if(!isCspec()||!rows.length)return;
 const c=cspecConfig();if(!c)return;
 const nfft=rows[0].length,k=['cspec',c.frequency,c.rate,nfft,c.mode].join('/');
 if(key!==k){key=k;clear();}
 const a=Number($('average').value),cur=rows[rows.length-1];
 if(trace&&trace.length!==nfft){trace=null;maximum=null;}
 trace=Array.from(cur,(v,i)=>trace?10*Math.log10(a*10**(trace[i]/10)+(1-a)*10**(v/10)):v);
 if(!maximum||maximum.length!==nfft)maximum=Array(nfft).fill(-Infinity);
 for(const r of rows)for(let i=0;i<nfft;i++)if(r[i]>maximum[i])maximum[i]=r[i];
 latest={frequency:c.frequency,rate:c.rate,fft:nfft,spectrum:trace};draw();
 const n=Math.min(rows.length,water.height);
 wc.drawImage(water,0,0,water.width,water.height-n,0,n,water.width,water.height-n);
 const newest=[];for(let r=0;r<n;r++)newest.push(rows[rows.length-1-r]);pushWater(newest);paintRows(newest,0);
 autoScale(trace);
 $('empty').hidden=true;labels(latest);
 cspecCount.push(performance.now());const now=performance.now();while(cspecCount.length&&cspecCount[0]<now-1000)cspecCount.shift();
 $('fps').textContent=`${cspecCount.length}`;$('fpsLabel').textContent='lines/s';
 $('throughput').textContent=(cspecCount.length*nfft/1e3).toFixed(0);$('throughputLabel').textContent=`kB/s over ${radio.transport} · ${c.rate/1e6} MS/s`;
 $('latency').textContent='0';$('latencyLabel').textContent=`gap-free · nfft ${nfft}`;
 let peak=0;for(let j=1;j<nfft;j++)if(cur[j]>cur[peak])peak=j;const pk=c.frequency*1e6+(peak-nfft/2)*c.rate/nfft;peakHzNominal=pk;$('peak').textContent=(pk*freqFactor()/1e6).toFixed(4);
 $('crc').textContent=`CSPEC · continuous · ${radio.spectrumCrcErrors?radio.spectrumCrcErrors+' CRC err':'OK'}`;
}
// ---- Dual-device gap-fill: a second board (B) mirrors A's band; both feed a shared ----
// RowMerger so a gap in one board's coverage is filled by the other. Only the power-spectrum
// streams (SPEC, CSPEC) merge. B drops to A-only on any B error (silent reconnect); A is never
// torn down by B. The merge is free-running here (gaps beat through phase), so coverage is
// best-effort; a guaranteed 100% needs two CGRID boards (grid lock, a later step).
function dualActive(){return dualOn&&!!radioB&&(isSpec()||isCspec());}
function rate1s(arr){const t=performance.now()-1000;while(arr.length&&arr[0]<t)arr.shift();return arr.length;}
async function dualStreamLoop(){
 const spec=isSpec(),c=spec?specConfig():cspecConfig();
 if(!c){await new Promise(r=>setTimeout(r,200));return;}
 const nb=spec?c.fft:c.nfft,maxHold=spec?c.maxHold:($('cspecDetector').value==='max'),rowMs=(spec?Number($('specRow').value):33)||33,dcMode=$('dcMode').value;
 const bOk=!!radioB&&!radioB.failed&&radioB.validFrequency(c.frequency)&&(spec?radioB.canStreamSpectrum&&radioB.spectrumProfiles(c.rate).some(p=>p[2]===nb):radioB.hasCspec&&radioB.rxRates.includes(c.rate));
 // Experimental grid-lock: with two CGRID boards in CSPEC, steer B's block phase to the
 // midpoint of A's (CADJ, proven safe mid-run) so they cover each other's gaps. Phase is
 // measured from block-arrival times; the gap-closing efficacy needs two physical CGRID
 // boards to validate. Inactive for S3 + C5 (the S3 has no CGRID), so it can never hurt it.
 const lock=bOk&&!spec&&!!radioB&&radioB.hasCgrid&&radio.hasCgrid;
 const blk={aT:0,bT:0,P:0},seqSeen={a:-1,b:-1};let steerTimer=0;
 dualMerger=new RowMerger(nb,maxHold,rowMs);
 dualCfg={c,nb,key:spec?specDisplayKey(c):['cspec',c.frequency,c.rate,c.nfft,c.mode].join('/')};
 dualRate={a:[],b:[],m:[]};dualBState=bOk?(lock?'grid-lock':'merging'):'idle';updateDualStatus();
 const changed=()=>{if(!dualActive())return true;const m=spec?specConfig():cspecConfig();if(!m)return true;return spec?($('dcMode').value!==dcMode||m.frequency!==c.frequency||m.gainMode!==c.gainMode||m.gain!==c.gain||m.bandwidth!==c.bandwidth||m.maxHold!==c.maxHold||m.rate!==c.rate||m.fft!==c.fft||Number($('specRow').value)!==rowMs):(m.frequency!==c.frequency||m.rate!==c.rate||m.nfft!==c.nfft||m.navg!==c.navg||m.mode!==c.mode||m.gainMode!==c.gainMode||m.gain!==c.gain);};
 if(!dualRAF)dualRAF=requestAnimationFrame(dualFrame);
 // Record each board's block-arrival time (on CSPEC seq change) and A's mean block period,
 // the inputs to the CADJ steering loop below.
 const mark=(src,meta)=>{if(!lock||!meta)return;const now=performance.now();if(src==='A'){if(meta.seq!==seqSeen.a){seqSeen.a=meta.seq;if(blk.aT){const d=now-blk.aT;blk.P=blk.P?blk.P*0.8+d*0.2:d;}blk.aT=now;}}else if(meta.seq!==seqSeen.b){seqSeen.b=meta.seq;blk.bT=now;}};
 const feed=src=>spec
  ?(h,bins)=>{if(changed())return;dualMerger.add(specToDbfs(bins,h.step,nb),h.ffts,performance.now(),src);dualRate[src==='A'?'a':'b'].push(performance.now());}
  :(line,meta)=>{if(changed())return;mark(src,meta);const sh=meta.sh,disp=new Float32Array(nb);for(let j=0;j<nb;j++)disp[j]=(line[j]-12*sh)/2-128;dualMerger.add(disp,1,performance.now(),src);dualRate[src==='A'?'a':'b'].push(performance.now());};
 let aErr=null,stopAll=false;
 const aStop=()=>stopAll||!connected||paused||changed();
 const bStop=()=>stopAll||!dualOn||!radioB||radioB.failed||!connected||paused||changed();
 const aStream=(spec?radio.spec(c,feed('A'),aStop):radio.cspec(c,feed('A'),aStop)).catch(e=>{aErr=e;stopAll=true;});
 let bStream=Promise.resolve();
 if(bOk){const gs=radioB.gainStep||1,gB=radioB.gainMin+Math.round((Math.max(radioB.gainMin,Math.min(radioB.gainMax,c.gain))-radioB.gainMin)/gs)*gs,cB={...c,gain:gB};bStream=(spec?radioB.spec(cB,feed('B'),bStop):radioB.cspec(cB,feed('B'),bStop)).catch(()=>{dualBState=radioB&&radioB.failed?'reconnecting':'idle';updateDualStatus();if(radioB&&radioB.failed)scheduleBRetry();});}
 // CADJ steering: nudge B toward a half-period offset from A. A direct writer write (not
 // run()-serialized) reaches B mid-stream without stopping it; the low 0.3 gain and the 5%
 // deadband keep the slow loop from ringing on host-timing jitter.
 if(lock)steerTimer=setInterval(()=>{if(!dualActive()||!radioB||radioB.failed||!blk.P||!blk.aT||!blk.bT)return;const P=blk.P;let err=P/2-((blk.bT-blk.aT)%P+P)%P;if(err>P/2)err-=P;if(err<-P/2)err+=P;if(Math.abs(err)<P*0.05)return;radioB.command('CADJ '+Math.round(Math.max(-P/2,Math.min(P/2,err*0.3))*1000)).catch(()=>{});},350);
 try{await Promise.all([aStream,bStream]);}finally{if(steerTimer)clearInterval(steerTimer);}
 if(aErr)throw aErr;
}
function dualFrame(){dualRAF=0;if(dualMerger){const rows=dualMerger.drain();if(rows.length){for(let i=0;i<rows.length;i++)dualRate.m.push(performance.now());renderMerged(rows);}}if(connected&&!paused&&dualActive())dualRAF=requestAnimationFrame(dualFrame);}
function renderMerged(rows){
 if(!dualActive()||!dualCfg||!rows.length)return;
 const {c,nb,key:k}=dualCfg;
 if(key!==k){key=k;clear();}
 const batch=new SpectrumAccumulator(nb,false);for(const r of rows)batch.add(r.bins,r.weight);const cur=batch.finish().bins;
 const a=Number($('average').value);if(trace&&trace.length!==nb){trace=null;maximum=null;}
 trace=Array.from(cur,(v,i)=>trace?10*Math.log10(a*10**(trace[i]/10)+(1-a)*10**(v/10)):v);
 if(!maximum||maximum.length!==nb)maximum=Array(nb).fill(-Infinity);
 for(const r of rows)for(let i=0;i<nb;i++){const p=r.peak?r.peak[i]:r.bins[i];if(p>maximum[i])maximum[i]=p;}
 latest={frequency:c.frequency,rate:c.rate,fft:nb,spectrum:trace};draw();
 const n=Math.min(rows.length,water.height);
 wc.drawImage(water,0,0,water.width,water.height-n,0,n,water.width,water.height-n);
 const newest=[];for(let r=0;r<n;r++)newest.push(rows[rows.length-1-r].bins);pushWater(newest);paintRows(newest,0);
 autoScale(trace);$('empty').hidden=true;labels(latest);
 $('fps').textContent=`${rate1s(dualRate.m)}`;$('fpsLabel').textContent='rows/s (merged)';
 $('throughputLabel').textContent=`gap-fill · ${c.rate/1e6} MS/s`;$('throughput').textContent='';
 updateDualStatus();
}
function updateDualStatus(){
 const el=$('dualStatus');if(!el)return;
 if(!dualOn||!radioB){el.hidden=true;return;}
 el.hidden=false;
 const name=radioB.deviceName||('ESP32-'+(radioB.family||'?'));
 const st=!(isSpec()||isCspec())?'switch to Spectrum or Live waterfall to merge'
  :dualBState==='reconnecting'?'reconnecting…':dualBState==='failed'?'disconnected'
  :dualBState==='idle'?'idle · band not supported by B':dualBState==='grid-lock'?'grid-lock (experimental)':'merging';
 el.textContent=`Gap-fill · ${name}: ${st}`;
 el.title=`A ${rate1s(dualRate.a)}/s + B ${rate1s(dualRate.b)}/s → merged ${rate1s(dualRate.m)}/s\n`+
  `Free-running merge fills most gaps; a guaranteed 100 % needs two CGRID boards (grid lock).`;
}
function scheduleBRetry(){
 clearTimeout(bRetryTimer);if(!dualOn||!bPort)return;
 bRetryTimer=setTimeout(async()=>{
  if(!dualOn||!bPort)return;
  try{const b=new BurstSerialRadio();await b.connect({port:bPort});if(!b.canStreamSpectrum&&!b.hasCspec){await b.close().catch(()=>{});throw Error('no spectrum stream');}radioB=b;dualBState='merging';}
  catch(e){dualBState='failed';scheduleBRetry();}
  updateDualStatus();
 },1500);
}
async function connectB(ev){
 if(connectionBusy||radio.changingBaud)return;
 if(!connected){error('Connect the main device before adding a gap-fill device.');return;}
 connectionBusy=true;state();
 try{
  const port=await SerialConnection.requestPort(ev?.kind);
  if(!port)return;
  const b=new BurstSerialRadio();
  await b.connect({port});
  if(!b.canStreamSpectrum&&!b.hasCspec){await b.close().catch(()=>{});throw Error('This device has no spectrum stream to merge; choose a board that streams SPEC or CSPEC.');}
  radioB=b;bPort=port;dualOn=true;dualBState='merging';
  alignDualBand();
  error('');
 }catch(e){error(e,!['NotFoundError','AbortError'].includes(e?.name));}
 finally{connectionBusy=false;updateDualStatus();state();}
}
// SPEC can only merge where A and B share a (rate, nfft) spectrum profile (e.g. an S3 only
// offers nfft 256 at 80 MS/s, so a C5 defaulting to a larger FFT would leave B idle). Snap the
// band to the largest shared profile, preferring the current rate. CSPEC needs no alignment:
// it is C5-only, so both boards share the same rates and FFT range.
function alignDualBand(){
 if(!dualOn||!radioB||!isSpec())return;
 const A=radio.specCapabilities?.profiles||[],B=radioB.specCapabilities?.profiles||[],common=[];
 for(const pa of A)for(const pb of B)if(pa[0]===pb[0]&&pa[2]===pb[2])common.push([pa[0],pa[2]]);
 if(!common.length)return; // no shared SPEC profile: B idles, the status chip says so
 const curRate=Number($('rate').value),atCur=common.filter(x=>x[0]===curRate);
 const pick=(atCur.length?atCur:common).sort((a,b)=>b[1]-a[1])[0];
 let moved=false;
 if(Number($('rate').value)!==pick[0]){$('rate').value=String(pick[0]);moved=true;}
 if(Number($('fft').value)!==pick[1]){$('fft').value=String(pick[1]);moved=true;}
 if(moved){state();labels();}
}
async function disconnectB(){
 clearTimeout(bRetryTimer);dualOn=false;const b=radioB;radioB=null;bPort=null;dualBState='';
 if(dualRAF){cancelAnimationFrame(dualRAF);dualRAF=0;}
 updateDualStatus();state();
 if(b)await b.run(()=>b.close()).catch(()=>{});
}
// ---- ESPsoup wideband panorama (SWEEP) -------------------------------------
// One pass f0..f1 per call; the outer loop re-issues it, one waterfall row per pass.
const SWEEP_OFFSET=40; // shift the arbitrary-reference dB into the dBFS display window
function sweepConfig(){
 const f0=Number($('sweepF0').value),f1=Number($('sweepF1').value),step=Number($('sweepStep').value),nfft=Number($('sweepFft').value),navg=Number($('sweepNavg').value)||8,rate=Number($('rate').value);
 if(!Number.isInteger(f0)||!Number.isInteger(f1)||!Number.isInteger(step)||f1<=f0||f1>6000||f0<50||step<1||(f1-f0)/step>2000||nfft*navg>16380)return null;
 return {rate,f0,f1,step,nfft,navg,gainMode,gain:Number($('gain').value)};
}
async function sweepLoop(){
 const c=sweepConfig();
 if(!c){await new Promise(r=>setTimeout(r,200));return;}
 const binHz=c.rate/c.nfft,spanHz=(c.f1-c.f0)*1e6,P=Math.max(32,Math.min(8192,Math.round(spanHz/binHz))),pano=new Float32Array(P).fill(-Infinity),base=c.f0*1e6,half=c.nfft/2;
 const changed=()=>{const m=sweepConfig();return !m||m.f0!==c.f0||m.f1!==c.f1||m.step!==c.step||m.rate!==c.rate||m.nfft!==c.nfft||m.navg!==c.navg||m.gainMode!==c.gainMode||m.gain!==c.gain;};
 const t0=performance.now();let steps=0,lastPaint=0;
 await radio.sweep(c,(meta,bins)=>{
  if(changed())return;steps++;
  // Map each step bin to the panorama by its fraction of the whole span (P may be
  // clamped below the natural bin count on a wide sweep; overlaps max-combine).
  for(let j=0;j<c.nfft;j++){const idx=Math.round((meta.mhz*1e6+(j-half)*binHz-base)/spanHz*P);if(idx<0||idx>=P)continue;const v=bins[j]-SWEEP_OFFSET;if(v>pano[idx])pano[idx]=v;}
  const now=performance.now();if(now-lastPaint>100){lastPaint=now;renderSweep(pano,c,P,false,steps,now-t0);}
 },()=>!connected||paused||!isSweep()||changed());
 if(!changed()&&isSweep())renderSweep(pano,c,P,true,steps,performance.now()-t0);
}
function renderSweep(pano,c,P,pushRow,steps,ms){
 const center=(c.f0+c.f1)/2,rate=(c.f1-c.f0)*1e6,k=['sweep',c.f0,c.f1,c.step,c.rate,c.nfft].join('/');
 if(key!==k){key=k;clear();}
 let mn=Infinity;for(let i=0;i<P;i++){const v=pano[i];if(v>-Infinity&&v<mn)mn=v;}if(mn===Infinity)mn=-120;
 const disp=new Array(P);for(let i=0;i<P;i++)disp[i]=pano[i]>-Infinity?pano[i]:mn;
 trace=disp;maximum=null;
 latest={frequency:center,rate,fft:P,spectrum:disp,steps,sweepMs:ms};draw();
 if(pushRow){wc.drawImage(water,0,0,water.width,water.height-1,0,1,water.width,water.height-1);pushWater([Float32Array.from(disp)]);paintRows([waterHist[0]],0);}
 autoScale(disp);
 $('empty').hidden=true;labels(latest);
 $('fps').textContent=ms?(1000/ms).toFixed(2):'—';$('fpsLabel').textContent='sweeps/s';
 $('throughput').textContent=`${steps}`;$('throughputLabel').textContent=`steps · ${c.rate/1e6} MS/s · ${c.nfft} bins`;
 $('latency').textContent=ms?ms.toFixed(0):'—';$('latencyLabel').textContent='ms / sweep';
 let peak=0;for(let j=1;j<P;j++)if(disp[j]>disp[peak])peak=j;const pk=c.f0*1e6+peak*(rate/P);peakHzNominal=pk;$('peak').textContent=(pk*freqFactor()/1e6).toFixed(3);
 $('crc').textContent=`SWEEP · ${c.f0}–${c.f1} MHz · ${radio.spectrumCrcErrors?radio.spectrumCrcErrors+' CRC err':'OK'}`;
}
// ---- ESPsoup device diagnostics into the debug panel -----------------------
async function refreshDiag(force){
 if(!connected||!radio.hasFwopt)return;
 // Any control line stops a running SPEC/CSPEC/SWEEP, so only query when idle.
 if(!force&&captureMode!=='iq'&&!paused)return;
 try{const d=await radio.diagnostics();if(d){deviceDiag=d;dbg.stat();}}catch(e){}
}
setInterval(()=>refreshDiag(false),3000);
for(const id of ['cspecFft','cspecDetector','cspecNavg','sweepFft','sweepNavg','sweepF0','sweepF1','sweepStep'])$(id).onchange=()=>labels();
function setCaptureMode(m){
 if(m===captureMode)return;
 if(m==='spec'&&!radio.canStreamSpectrum)return;
 if(m==='cspec'&&!radio.hasCspec)return;
 if(m==='sweep'&&!radio.hasSweep)return;
 captureMode=m;
 // Re-align the shared band when entering a merge mode so a board B added earlier (e.g. while
 // in I/Q) starts merging instead of idling on a profile mismatch. No-op without B.
 alignDualBand();
 // The mode bar sits outside the aside, so its change is not auto-saved by the aside listener.
 markDirty();state();labels();clear();
}
for(const [id,m] of [['modeIq','iq'],['modeSpec','spec'],['modeCspec','cspec'],['modeSweep','sweep']])$(id).onclick=()=>setCaptureMode(m);
// Auto scale: floor a little under the noise (20th percentile), top a little
// above the strongest bin; applied at most twice a second, smoothed, without
// clearing the waterfall.
let autoPk=null;
// Calm auto scale: floor = 20th percentile - 10 dB in 5 dB steps (4 dB hysteresis),
// top = slowly decaying peak hold + 5 dB in 10 dB steps; evaluated once a second.
function autoScale(values){
 if(!$('autoscale').checked||!values?.length)return;
 const now=performance.now();if(now-autoT<1000)return;autoT=now;
 const v=Array.from(values).filter(Number.isFinite).sort((a,b)=>a-b);if(v.length<8)return;
 const nf=v[Math.floor(v.length*.2)]-10,pk=v[v.length-1];autoPk=autoPk===null?pk:Math.max(pk,autoPk-2);
 const f0=Number($('floor').value),r0=Number($('range').value);
 let floor=Math.abs(nf-f0)>4?Math.round(nf/5)*5:f0,top=f0+r0;
 if(autoPk+5>top||autoPk+25<top)top=Math.ceil((autoPk+5)/10)*10;
 floor=Math.max(-140,Math.min(-40,floor));const range=Math.max(20,Math.min(120,top-floor));
 if(floor===f0&&range===r0)return;
 $('floor').value=floor;$('range').value=range;
 $('floorValue').textContent=floor+' dBFS';$('rangeValue').textContent=range+' dB';
 $('scale').textContent=`${floor} → ${floor+range} dBFS`;redrawWater();draw();
}
$('autoscale').onchange=()=>{autoT=0;autoPk=null;};
// ---- spectrum / waterfall splitter ----------------------------------------
// Split spectrum/waterfall by flex-grow weights (not absolute px heights):
// the sum is capped by the viewport-bounded column, so dragging never reintroduces
// scroll. A block's weight = desired canvas height + its chrome (charthead, axis,
// meas), so the canvas lands exactly on the target value (80px floor).
{const sp=$('splitter'),specChart=spec.closest('.chart'),waterChart=water.closest('.chart'),def=[220,380],
  set=(hs,hw)=>{const cs=specChart.clientHeight-spec.clientHeight,cw=waterChart.clientHeight-water.clientHeight;specChart.style.flexGrow=hs+cs;waterChart.style.flexGrow=hw+cw;resize();redrawWater();};
 let v=def;try{const s=JSON.parse(localStorage.getItem('espSdrSplitRatio')||'null');if(Array.isArray(s)&&s.length===2&&s.every(n=>Number.isFinite(n)&&n>0))v=s;}catch(e){}set(v[0],v[1]);
 let sd=null;sp.addEventListener('pointerdown',e=>{sd={y:e.clientY,hs:spec.clientHeight,hw:water.clientHeight};sp.setPointerCapture(e.pointerId);sp.classList.add('drag');e.preventDefault();});
 sp.addEventListener('pointermove',e=>{if(!sd)return;const tot=sd.hs+sd.hw,hs=Math.max(80,Math.min(tot-80,sd.hs+e.clientY-sd.y));set(hs,tot-hs);});
 sp.addEventListener('pointercancel',()=>{sd=null;sp.classList.remove('drag');});
 sp.addEventListener('pointerup',()=>{if(!sd)return;sd=null;sp.classList.remove('drag');try{localStorage.setItem('espSdrSplitRatio',JSON.stringify([spec.clientHeight,water.clientHeight]));}catch(e){}});
 sp.addEventListener('dblclick',()=>{set(def[0],def[1]);try{localStorage.removeItem('espSdrSplitRatio');}catch(e){}});}

// Start without a click: connect to the remembered port as soon as the page
// loads and whenever a device is plugged in (only ports this site was granted).
if(SerialConnection.supported()){SerialConnection.onConnect(()=>setTimeout(()=>$('connect').onclick({auto:true}),500));
 setTimeout(()=>$('connect').onclick({auto:true}),300);}
