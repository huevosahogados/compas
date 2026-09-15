// ═══════════════════════════════════════════════════════════════════════════
// Compás — shared metronome module.
//
// Used by both interleaves_v2.html (mounted as a floating panel) and
// compas.html (mounted as a standalone full-page instance). This file owns
// all metronome behavior: the audio scheduler, the dial, tap tempo, accent
// patterns, and localStorage persistence of the last-used settings.
//
// It knows NOTHING about Scores, Passages, or any host app's data model.
// A host page that wants to associate settings with something of its own
// (e.g. Interleaves saving settings to a Passage) does so through the public
// API below (getSettings/loadSettings) plus the "slot" element returned by
// mount(), which is an empty container the host can fill with its own UI.
//
// Public API (window.Compas):
//   mount(container, opts)  → {panelElement, slotElement}
//     opts.mode: 'panel' (default, floating draggable, show/hide via
//                togglePanel) or 'standalone' (static, always visible,
//                fills its container instead of floating).
//   togglePanel()            — show/hide (no-op in standalone mode)
//   start() / stop() / isRunning()
//   getAudioContext()        — shared AudioContext, for a host's own sounds
//                               (e.g. Interleaves' rest-period chime) so the
//                               page doesn't accumulate multiple contexts
//   getSettings()             → {bpm,beats,accentPattern,beat1mode,freeClick,panelPos}
//   loadSettings(settings)   — applies a settings object; does not auto-start
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  'use strict';

  const MIN_BPM=40, MAX_BPM=208, LOOKAHEAD=0.1, INTERVAL=25;

  let audioCtx=null;
  let bpm=120, beatsPerBar=4, running=false, currentBeat=0, nextNoteTime=0, scheduleTimer=null;
  let accents=[true,false,false,false], freeClick=false;
  let beat1Mode='downbeat'; // 'downbeat' | 'accent' | 'plain' — click beat-1 to cycle
  let panelPos=null; // {left,top} in px, null = default corner position
  let tapTimes=[];
  let mode='panel';
  let panelEl=null, dialWrapEl=null, bpmInputEl=null, needleEl=null, accentRowEl=null, startBtnEl=null, countBtnsEl=null, ticksGroupEl=null;

  function clampBpm(v){return Math.max(MIN_BPM,Math.min(MAX_BPM,v));}

  // ── Audio engine ────────────────────────────────────────────────────────
  function getAudioContext(){
    if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended')audioCtx.resume();
    return audioCtx;
  }

  function scheduleBeat(beatNum,time){
    const ctx=getAudioContext();
    const osc=ctx.createOscillator();const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    const isBeat1=!freeClick&&beatNum===0&&beat1Mode==='downbeat';
    const isAccent=!freeClick&&beatNum===0?beat1Mode==='accent':!freeClick&&(accents[beatNum]||false);
    if(isBeat1){
      const freq=1800,dur=0.5;
      osc.type='triangle';osc.frequency.setValueAtTime(freq,time);
      gain.gain.setValueAtTime(0.55,time);gain.gain.exponentialRampToValueAtTime(0.001,time+dur);
      osc.start(time);osc.stop(time+dur);
      const o2=ctx.createOscillator();const g2=ctx.createGain();
      o2.connect(g2);g2.connect(ctx.destination);
      o2.type='sine';o2.frequency.setValueAtTime(freq*2.76,time);
      g2.gain.setValueAtTime(0.18,time);g2.gain.exponentialRampToValueAtTime(0.001,time+dur*0.4);
      o2.start(time);o2.stop(time+dur*0.4);
    }else if(isAccent){
      osc.type='sine';osc.frequency.setValueAtTime(1320,time);
      gain.gain.setValueAtTime(0.35,time);gain.gain.exponentialRampToValueAtTime(0.001,time+0.04);
      osc.start(time);osc.stop(time+0.05);
    }else{
      osc.type='sine';osc.frequency.setValueAtTime(880,time);
      gain.gain.setValueAtTime(0.3,time);gain.gain.exponentialRampToValueAtTime(0.001,time+0.04);
      osc.start(time);osc.stop(time+0.05);
    }
    const delay=Math.max(0,(time-ctx.currentTime)*1000);
    setTimeout(()=>{
      if(!document.documentElement.classList.contains('eink')&&accentRowEl){
        const dots=accentRowEl.querySelectorAll('.metro-accent-btn');
        if(dots[beatNum]){dots[beatNum].style.opacity='0.4';setTimeout(()=>{if(dots[beatNum])dots[beatNum].style.opacity='';},100);}
      }
    },delay);
  }

  function scheduler(){
    const ctx=getAudioContext();
    while(nextNoteTime<ctx.currentTime+LOOKAHEAD){
      scheduleBeat(currentBeat,nextNoteTime);
      nextNoteTime+=60.0/bpm;
      if(freeClick||beatsPerBar===0)currentBeat=0;else currentBeat=(currentBeat+1)%beatsPerBar;
    }
  }

  function start(){
    const ctx=getAudioContext();
    running=true;currentBeat=0;nextNoteTime=ctx.currentTime+0.05;
    scheduleTimer=setInterval(scheduler,INTERVAL);
    if(startBtnEl){startBtnEl.textContent='stop';startBtnEl.classList.add('running');}
  }
  function stop(){
    running=false;clearInterval(scheduleTimer);
    if(startBtnEl){startBtnEl.textContent='start';startBtnEl.classList.remove('running');}
  }
  function toggle(){if(running)stop();else start();}

  // ── Beats / accents ─────────────────────────────────────────────────────
  function setBeats(n){
    beatsPerBar=n;freeClick=false;
    const prev=accents;
    accents=Array.from({length:n},(_,i)=>i===0?true:(prev[i]||false));
    currentBeat=0;
    if(countBtnsEl)countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.toggle('active',+b.textContent===n));
    renderAccentGrid();saveSettings();
  }
  function toggleBeats(n){
    const wasActive=beatsPerBar===n&&!freeClick;
    if(wasActive){
      freeClick=true;beatsPerBar=0;
      if(countBtnsEl)countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.remove('active'));
      if(accentRowEl)accentRowEl.innerHTML='';
      saveSettings();return;
    }
    freeClick=false;setBeats(n);
  }
  function toggleAccent(beat){if(beat===0)return;accents[beat]=!accents[beat];renderAccentGrid();saveSettings();}
  function toggleBeat1(){beat1Mode=beat1Mode==='downbeat'?'accent':beat1Mode==='accent'?'plain':'downbeat';renderAccentGrid();saveSettings();}
  function renderAccentGrid(){
    if(!accentRowEl)return;
    accentRowEl.innerHTML='';
    for(let i=0;i<beatsPerBar;i++){
      const btn=document.createElement('button');
      if(i===0){
        btn.className='metro-accent-btn'+(beat1Mode==='downbeat'?' beat1':beat1Mode==='accent'?' accented':'');
        btn.textContent='1';btn.title='downbeat: click to cycle (downbeat → accent → plain)';
        btn.addEventListener('click',toggleBeat1);
      }else{
        btn.className='metro-accent-btn'+(accents[i]?' accented':'');
        btn.textContent=String(i+1);
        btn.addEventListener('click',()=>toggleAccent(i));
      }
      accentRowEl.appendChild(btn);
    }
  }

  // ── Tempo / dial / tap ──────────────────────────────────────────────────
  function updateBPMDisplay(){
    if(bpmInputEl&&document.activeElement!==bpmInputEl)bpmInputEl.value=bpm;
    const pct=(bpm-MIN_BPM)/(MAX_BPM-MIN_BPM);
    if(needleEl)needleEl.setAttribute('transform','rotate('+(pct*270-135)+' 100 100)');
  }
  function setBPMFromInput(val){if(isNaN(val))return;bpm=clampBpm(Math.round(val));updateBPMDisplay();saveSettings();}
  function initDial(){
    let dragging=false;
    function angleFromEvent(e){
      if(!dialWrapEl)return 0;
      const rect=dialWrapEl.getBoundingClientRect();const src=e.touches?e.touches[0]:e;
      return Math.atan2(src.clientY-rect.top-rect.height/2,src.clientX-rect.left-rect.width/2);
    }
    function bpmFromAngle(angle){
      let deg=angle*180/Math.PI;
      let sweep=((deg+90+360)%360-225+360)%360;
      if(sweep>270)sweep=sweep>315?0:270;
      return Math.round(MIN_BPM+(sweep/270)*(MAX_BPM-MIN_BPM));
    }
    document.addEventListener('mousedown',e=>{if(dialWrapEl&&dialWrapEl.contains(e.target)){dragging=true;bpm=bpmFromAngle(angleFromEvent(e));updateBPMDisplay();}});
    document.addEventListener('mousemove',e=>{if(!dragging)return;bpm=bpmFromAngle(angleFromEvent(e));updateBPMDisplay();});
    document.addEventListener('mouseup',()=>{if(dragging){dragging=false;saveSettings();}});
    document.addEventListener('touchstart',e=>{if(dialWrapEl&&dialWrapEl.contains(e.target)){dragging=true;bpm=bpmFromAngle(angleFromEvent(e));updateBPMDisplay();}},{passive:true});
    document.addEventListener('touchmove',e=>{if(!dragging)return;bpm=bpmFromAngle(angleFromEvent(e));updateBPMDisplay();},{passive:true});
    document.addEventListener('touchend',()=>{if(dragging){dragging=false;saveSettings();}});
  }
  function tap(){
    const now=Date.now();
    if(tapTimes.length>0&&now-tapTimes[tapTimes.length-1]>2000)tapTimes=[];
    tapTimes.push(now);if(tapTimes.length>6)tapTimes.shift();
    if(tapTimes.length>=2){
      let ti=0;for(let i=1;i<tapTimes.length;i++)ti+=tapTimes[i]-tapTimes[i-1];
      bpm=clampBpm(Math.round(60000/(ti/(tapTimes.length-1))));
      updateBPMDisplay();saveSettings();
    }
  }
  function renderDialTicks(){
    if(!ticksGroupEl)return;
    const labeled=new Set([40,82,124,166,208]);let svg='';
    for(let b=40;b<=208;b+=2){
      if(labeled.has(b))continue;
      const pct=(b-MIN_BPM)/(MAX_BPM-MIN_BPM);const angle=(pct*270-135)*Math.PI/180;
      const x1=100+82*Math.sin(angle),y1=100-82*Math.cos(angle),x2=100+79*Math.sin(angle),y2=100-79*Math.cos(angle);
      svg+=`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`;
    }
    ticksGroupEl.innerHTML=svg;
  }

  // ── Persistence (localStorage — the last-used settings, independent of
  //    any host-specific association like Interleaves' Passage linkage) ──
  function saveSettings(){
    try{localStorage.setItem('compas_settings',JSON.stringify({bpm,beatsPerBar,accents,freeClick,beat1mode:beat1Mode,panelPos}));}catch(e){}
  }
  function loadSavedSettings(){
    try{
      const raw=localStorage.getItem('compas_settings');if(!raw)return;
      const s=JSON.parse(raw);
      if(s.bpm)bpm=clampBpm(s.bpm);
      if(s.beatsPerBar)beatsPerBar=s.beatsPerBar;
      if(Array.isArray(s.accents))accents=s.accents;
      if(typeof s.freeClick==='boolean')freeClick=s.freeClick;
      if(s.beat1mode)beat1Mode=s.beat1mode;
      if(s.panelPos&&typeof s.panelPos.left==='number')panelPos=s.panelPos;
    }catch(e){}
  }

  // Public: returns a plain settings object a host can persist however it likes
  // (e.g. Interleaves writes this onto a Passage; a future host could store presets).
  function getSettings(){
    return {bpm,beats:beatsPerBar,accentPattern:accents.slice(),beat1mode:beat1Mode,freeClick,panelPos};
  }
  // Public: applies a settings object to the live metronome. Never auto-starts.
  function loadSettings(settings){
    if(!settings)return;
    bpm=clampBpm(settings.bpm||120);
    freeClick=!!settings.freeClick;
    beat1Mode=settings.beat1mode||'downbeat';
    if(!freeClick&&settings.beats){
      beatsPerBar=settings.beats;
      accents=Array.isArray(settings.accentPattern)?settings.accentPattern.slice():accents;
    }
    updateBPMDisplay();
    if(freeClick){
      if(countBtnsEl)countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.remove('active'));
      if(accentRowEl)accentRowEl.innerHTML='';
    }else{
      if(countBtnsEl)countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.toggle('active',+b.textContent===beatsPerBar));
      renderAccentGrid();
    }
    if(settings.panelPos&&typeof settings.panelPos.left==='number'){
      panelPos=settings.panelPos;
      if(mode==='panel'&&panelEl&&panelEl.classList.contains('show'))applyPanelPos();
    }
  }

  // ── Panel positioning / dragging (mode:'panel' only) ────────────────────
  function applyPanelPos(){
    if(!panelPos||!panelEl)return;
    const left=Math.max(0,Math.min(panelPos.left,window.innerWidth-panelEl.offsetWidth));
    const top=Math.max(0,Math.min(panelPos.top,window.innerHeight-panelEl.offsetHeight));
    panelEl.style.bottom='auto';panelEl.style.right='auto';
    panelEl.style.left=left+'px';panelEl.style.top=top+'px';
  }
  function togglePanel(){
    if(mode!=='panel'||!panelEl)return;
    const opening=!panelEl.classList.contains('show');
    panelEl.classList.toggle('show');
    if(opening)applyPanelPos();
  }
  function initPanelDrag(headerEl,closeBtnEl){
    let dragging=false,startX,startY,origLeft,origTop;
    function startDrag(e){
      const src=e.touches?e.touches[0]:e;
      if(!headerEl.contains(e.target))return;
      if(closeBtnEl&&e.target.closest&&e.target.closest('#'+closeBtnEl.id))return;
      if(bpmInputEl&&e.target.closest&&e.target.closest('#'+bpmInputEl.id))return;
      e.preventDefault();dragging=true;
      const rect=panelEl.getBoundingClientRect();
      panelEl.style.bottom='auto';panelEl.style.right='auto';
      panelEl.style.left=rect.left+'px';panelEl.style.top=rect.top+'px';
      origLeft=rect.left;origTop=rect.top;startX=src.clientX;startY=src.clientY;
    }
    function moveDrag(e){
      if(!dragging)return;e.preventDefault();
      const src=e.touches?e.touches[0]:e;
      const newLeft=Math.max(0,Math.min(origLeft+src.clientX-startX,window.innerWidth-panelEl.offsetWidth));
      const newTop=Math.max(0,Math.min(origTop+src.clientY-startY,window.innerHeight-panelEl.offsetHeight));
      panelEl.style.left=newLeft+'px';panelEl.style.top=newTop+'px';
    }
    function endDrag(){
      if(dragging){dragging=false;panelPos={left:parseInt(panelEl.style.left)||0,top:parseInt(panelEl.style.top)||0};saveSettings();}
    }
    document.addEventListener('mousedown',startDrag);
    document.addEventListener('mousemove',moveDrag);
    document.addEventListener('mouseup',endDrag);
    document.addEventListener('touchstart',startDrag,{passive:false});
    document.addEventListener('touchmove',moveDrag,{passive:false});
    document.addEventListener('touchend',endDrag);
  }

  // ── Markup + mount ───────────────────────────────────────────────────────
  const TEMPLATE=`
    <div id="metro-header" title="drag to move">
      <span id="metro-title">Compás</span>
      <div id="metro-bpm-display">
        <input id="metro-bpm" type="number" min="40" max="208" value="120">
        <span id="metro-bpm-unit">bpm</span>
      </div>
      <button id="metro-close">✕</button>
    </div>
    <div id="metro-body">
      <div id="metro-dial-wrap">
        <svg id="metro-dial" viewBox="0 0 200 200" width="224" height="224">
          <circle cx="100" cy="100" r="82" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
          <line x1="42.0" y1="158.0" x2="47.7" y2="152.3" stroke="rgba(255,255,255,0.9)" stroke-width="2.5"/>
          <line x1="24.2" y1="68.6"  x2="31.6" y2="71.7"  stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
          <line x1="100"  y1="18"    x2="100"  y2="26"    stroke="rgba(255,255,255,0.9)" stroke-width="2.5"/>
          <line x1="175.8" y1="68.6" x2="168.4" y2="71.7" stroke="rgba(255,255,255,0.7)" stroke-width="2"/>
          <line x1="158.0" y1="158.0" x2="152.3" y2="152.3" stroke="rgba(255,255,255,0.9)" stroke-width="2.5"/>
          <g id="metro-small-ticks"></g>
          <text x="57.6" y="145.9" text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)" font-family="monospace">40</text>
          <text x="44.6" y="80.5"  text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)" font-family="monospace">82</text>
          <text x="100"  y="43.5"  text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)" font-family="monospace">124</text>
          <text x="155.4" y="80.5" text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)" font-family="monospace">166</text>
          <text x="142.4" y="145.9" text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)" font-family="monospace">208</text>
          <line id="metro-dial-needle" x1="100" y1="100" x2="100" y2="22"
            stroke="rgba(255,255,255,0.95)" stroke-width="2.5" stroke-linecap="round"
            transform="rotate(-135 100 100)"/>
          <circle cx="100" cy="100" r="4" fill="rgba(255,255,255,0.9)"/>
        </svg>
      </div>
      <div id="metro-beats-row">
        <div id="metro-beat-count-btns">
          <button class="metro-count-btn" data-beats="2">2</button>
          <button class="metro-count-btn" data-beats="3">3</button>
          <button class="metro-count-btn active" data-beats="4">4</button>
          <button class="metro-count-btn" data-beats="5">5</button>
          <button class="metro-count-btn" data-beats="6">6</button>
          <button class="metro-count-btn" data-beats="7">7</button>
        </div>
      </div>
      <div id="metro-accent-row"></div>
      <div id="metro-controls">
        <button id="metro-tap">tap</button>
        <button id="metro-start">start</button>
      </div>
      <div id="metro-passage-row" style="display:none;width:100%;"></div>
    </div>`;

  function mount(container,opts){
    opts=opts||{};mode=opts.mode==='standalone'?'standalone':'panel';
    panelEl=document.createElement('div');
    panelEl.id='metro-panel';
    if(mode==='standalone')panelEl.classList.add('compas-standalone');
    panelEl.innerHTML=TEMPLATE;
    container.appendChild(panelEl);

    dialWrapEl=panelEl.querySelector('#metro-dial-wrap');
    bpmInputEl=panelEl.querySelector('#metro-bpm');
    needleEl=panelEl.querySelector('#metro-dial-needle');
    accentRowEl=panelEl.querySelector('#metro-accent-row');
    startBtnEl=panelEl.querySelector('#metro-start');
    countBtnsEl=panelEl.querySelector('#metro-beat-count-btns');
    ticksGroupEl=panelEl.querySelector('#metro-small-ticks');
    const closeBtnEl=panelEl.querySelector('#metro-close');
    const headerEl=panelEl.querySelector('#metro-header');
    const tapBtnEl=panelEl.querySelector('#metro-tap');
    const slotEl=panelEl.querySelector('#metro-passage-row');

    bpmInputEl.addEventListener('change',()=>setBPMFromInput(+bpmInputEl.value));
    bpmInputEl.addEventListener('input',()=>setBPMFromInput(+bpmInputEl.value));
    bpmInputEl.addEventListener('focus',()=>bpmInputEl.select());
    bpmInputEl.addEventListener('click',()=>bpmInputEl.select());
    closeBtnEl.addEventListener('click',togglePanel);
    tapBtnEl.addEventListener('click',tap);
    startBtnEl.addEventListener('click',toggle);
    countBtnsEl.querySelectorAll('.metro-count-btn').forEach(btn=>{
      btn.addEventListener('click',()=>toggleBeats(+btn.dataset.beats));
    });

    if(mode==='panel')initPanelDrag(headerEl,closeBtnEl);
    initDial();

    loadSavedSettings();
    updateBPMDisplay();
    if(freeClick){
      countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.remove('active'));
    }else{
      countBtnsEl.querySelectorAll('.metro-count-btn').forEach(b=>b.classList.toggle('active',+b.dataset.beats===beatsPerBar));
      renderAccentGrid();
    }
    renderDialTicks();

    return {panelElement:panelEl,slotElement:slotEl};
  }

  window.Compas={
    mount,
    togglePanel,
    start,stop,toggle,
    isRunning:()=>running,
    getAudioContext,
    getSettings,
    loadSettings
  };
})();
