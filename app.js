/* =====================================================================
 * app.js  —  静的磁気・絶対トー計測
 *   変更: 8の字校正を「任意」に。未校正でも車両ゼロ→各輪計測へ進める。
 *         （トー=輪方位−車両方位の差分でハードアイアンが相殺するため）
 *   依存: estimator.js, sensors.js, magnetics.js
 * ===================================================================== */
(function () {
  'use strict';
  const E = window.Estimator, Mag = window.Magnetics;
  const { SensorHub } = window.Sensors;
  const V = Mag.V;

  const WHEELS = ['FL','FR','RL','RR'];
  const WLAB = { FL:'前左 FL', FR:'前右 FR', RL:'後左 RL', RR:'後右 RR' };

  const cfg = {
    slideOffsets: [0,10,20,30],
    avgMs: 1500,
    nAccept: 3,
    calMs: 12000,
    dirAxis: [1,0,0],
  };

  const state = {
    hub: new SensorHub(),
    cal: null,            // 任意。null=未校正でも可
    calBuf: [],
    vehicleAz: null,
    accelStatic: [0,0,9.81],
    slide: {}, camber:{}, accepted:{}, results:{}, rawlog:[],
    curWheel:'FL', curLevel:0,
    phase:'idle', avgBuf:null, lastEffHz:0, hasMag:false,
  };
  WHEELS.forEach(w=>{ state.slide[w]=[]; state.camber[w]=[]; state.accepted[w]=[]; });

  const $ = id=>document.getElementById(id);
  const el={};
  ['status','mode','effhz','magok','wheel','level','phase','liveCamber','liveMag',
   'calState','calCoverage','calResidual','vehAz','acceptCount',
   'permBtn','startBtn','calBtn','calClearBtn','vehBtn','slideBtn','resetWheelBtn',
   'wheelSel','csvBtn','resetBtn','results','log','offsets']
   .forEach(id=>el[id]=$(id));

  const logLine=s=>{ const t=new Date().toLocaleTimeString(); el.log.textContent=`[${t}] ${s}\n`+el.log.textContent; };
  const setStatus=s=>{ el.status.textContent=s; };
  const f=x=>Math.round(x*1000)/1000;

  function onSample(sample){
    state.lastEffHz=state.hub.effectiveHz;
    el.effhz.textContent=state.lastEffHz.toFixed(0)+' Hz';
    state.hasMag = state.hub.hasMag && !!sample.mag;
    el.magok.textContent = state.hub.hasMag ? (sample.mag?'OK':'待機') : '非対応';

    el.liveCamber.textContent=E.camberStatic(sample.accel,[0,0,1]).toFixed(2)+'°';
    if(sample.mag) el.liveMag.textContent=V.norm(sample.mag).toFixed(1)+'µT';

    if(state.phase==='cal' && sample.mag){ state.calBuf.push(sample.mag.slice()); }
    if((state.phase==='veh'||state.phase==='slide') && state.avgBuf){
      state.avgBuf.accel.push(sample.accel.slice());
      if(sample.mag) state.avgBuf.mag.push(sample.mag.slice());
    }
    if(state.phase!=='idle' && sample.mag){
      state.rawlog.push({ t_ms:Math.round(sample.t_ms), phase:state.phase, wheel:state.curWheel, level:state.curLevel,
        ax:f(sample.accel[0]),ay:f(sample.accel[1]),az:f(sample.accel[2]),
        mx:f(sample.mag[0]),my:f(sample.mag[1]),mz:f(sample.mag[2]) });
    }
  }

  async function requestPerm(){ const ok=await SensorHub.requestPermission(); logLine(ok?'権限OK':'権限拒否'); }
  async function startSensors(){
    try{
      const mode=await state.hub.start(onSample);
      el.mode.textContent=mode;
      setStatus('センサ起動: '+mode+(state.hub.hasMag?'（磁気OK）':'（磁気非対応）'));
      logLine('起動 mode='+mode+' mag='+state.hub.hasMag);
      el.startBtn.disabled=true;
      // メインフローは校正を一切待たない：車両ゼロを即解放
      el.vehBtn.disabled=false;
      // 校正は完全に任意（オプション）。実行/クリアはいつでも可能
      el.calBtn.disabled=false;
      el.calClearBtn.disabled=false;
      if(state.hub.hasMag) setStatus('起動OK。そのまま「2. 車両ゼロ」へ進めます（校正は任意）');
      else setStatus('⚠ 磁気非対応。chrome://flags の Experimental Web Platform features を有効化してください');
    }catch(e){ setStatus('起動失敗: '+e.message); logLine('起動失敗 '+e.message); }
  }

  // ---- 8の字校正（任意）----
  function startCal(){
    if(!state.hasMag){ setStatus('磁気が読めていません（校正は任意なのでスキップ可）'); return; }
    state.phase='cal'; state.calBuf=[];
    el.calState.textContent='収集中…';
    setStatus('8の字校正(任意): 端末をあらゆる向きへ ゆっくり回す（約'+(cfg.calMs/1000)+'秒）');
    el.phase.textContent='校正中';
    let left=cfg.calMs/1000;
    const iv=setInterval(()=>{ left--; el.calState.textContent=`収集中… 残り${left}s (${state.calBuf.length}点)`; if(left<=0)clearInterval(iv); },1000);
    setTimeout(()=>{
      state.phase='idle';
      const cal=Mag.hardIronFit(state.calBuf);
      if(!cal){ el.calState.textContent='点数不足→スキップ推奨'; setStatus('校正失敗。任意なのでこのまま車両ゼロへ進めます'); return; }
      state.cal=cal;
      el.calState.textContent='完了 ✓';
      el.calCoverage.textContent=(cal.coverage*100).toFixed(0)+'%';
      el.calResidual.textContent=cal.residualPct.toFixed(1)+'%';
      const q = cal.residualPct<3 && cal.coverage>0.5 ? '良好' : (cal.residualPct<8?'可(このまま使用可)':'粗い→スキップ推奨');
      setStatus(`校正完了 残差${cal.residualPct.toFixed(1)}% 網羅${(cal.coverage*100).toFixed(0)}% → ${q}`);
      logLine(`校正 offset=[${cal.offset.map(x=>x.toFixed(1))}] res=${cal.residualPct.toFixed(1)}% cov=${(cal.coverage*100).toFixed(0)}%`);
    }, cfg.calMs);
  }
  function clearCal(){
    state.cal=null;
    el.calState.textContent='未校正';
    el.calCoverage.textContent='–'; el.calResidual.textContent='–';
    setStatus('校正をクリアしました（未校正で計測します）');
    logLine('校正クリア（未校正）');
  }

  function beginAvg(){ state.avgBuf={accel:[],mag:[]}; }
  function endAvg(){
    const a=state.avgBuf.accel.length?V.mean(state.avgBuf.accel):[0,0,9.81];
    const m=state.avgBuf.mag.length?V.mean(state.avgBuf.mag):null;
    state.avgBuf=null; return {accel:a, mag:m};
  }

  function takeVehicle(){
    if(!state.hasMag){ setStatus('磁気が読めていません'); return; }
    if(state.phase==='cal'){ setStatus('校正の完了を待つか、校正をクリアしてから実行してください'); return; }
    state.phase='veh'; beginAvg();
    setStatus('車両ゼロ取得中… ドリンクホルダー壁に沿わせて静止');
    el.phase.textContent='車両基準';
    setTimeout(()=>{
      const r=endAvg(); state.phase='idle';
      if(!r.mag){ setStatus('磁気取得失敗'); return; }
      const up=V.unit(r.accel);
      const Eclean=Mag.applyHardIron(r.mag, state.cal); // cal=nullなら生値
      state.vehicleAz=Mag.magneticHeading(Eclean, up, cfg.dirAxis);
      state.accelStatic=r.accel;
      el.vehAz.textContent=state.vehicleAz.toFixed(2)+'°';
      setStatus(`車両ゼロ=${state.vehicleAz.toFixed(2)}°${state.cal?'':'(未校正)'}。各輪の計測へ`);
      logLine(`車両ゼロ az=${state.vehicleAz.toFixed(2)}° cal=${state.cal?'あり':'なし'}`);
      el.slideBtn.disabled=false;
    }, cfg.avgMs);
  }

  function measureSlide(){
    if(state.vehicleAz==null){ setStatus('先に車両ゼロ基準を'); return; }
    if(!state.hasMag){ setStatus('磁気が読めていません'); return; }
    if(state.phase==='cal'){ setStatus('校正中です。完了を待つかクリアしてください'); return; }
    state.phase='slide'; beginAvg();
    const off=cfg.slideOffsets[state.curLevel];
    setStatus(`[${WLAB[state.curWheel]}] 水準${state.curLevel+1}/${cfg.slideOffsets.length} (${off}cm) 静止…`);
    el.phase.textContent=`計測 L${state.curLevel+1}`;
    setTimeout(()=>{
      const r=endAvg(); state.phase='idle';
      if(!r.mag){ setStatus('磁気取得失敗、やり直し'); return; }
      const mClean=Mag.applyHardIron(r.mag, state.cal);
      state.slide[state.curWheel][state.curLevel]={ mag:mClean, accel:r.accel };
      state.camber[state.curWheel].push(E.camberStatic(r.accel,[0,0,1]));
      logLine(`[${state.curWheel}] L${state.curLevel+1}(${off}cm) |B|=${V.norm(mClean).toFixed(1)}µT`);
      if(state.curLevel < cfg.slideOffsets.length-1){
        state.curLevel++;
        el.level.textContent=`${state.curLevel+1}/${cfg.slideOffsets.length}`;
        setStatus(`水準${state.curLevel+1}へ: 端末を ${cfg.slideOffsets[state.curLevel]}cm 位置へスライドし「スライド計測」`);
      } else {
        finalizeOneToe();
        state.curLevel=0; el.level.textContent=`1/${cfg.slideOffsets.length}`;
      }
    }, cfg.avgMs);
  }

  function finalizeOneToe(){
    const reads=state.slide[state.curWheel].map(x=>x.mag);
    const sep=Mag.slideSeparate(reads, cfg.slideOffsets, {exponent:3});
    if(!sep.ok){ setStatus('分離失敗'); return; }
    const up=V.unit(state.slide[state.curWheel][0].accel);
    const az=Mag.magneticHeading(sep.E, up, cfg.dirAxis);
    const toe=Mag.toeFromHeadings(az, state.vehicleAz);
    state.accepted[state.curWheel].push(toe);
    state.slide[state.curWheel]=[];
    el.acceptCount.textContent=`${state.accepted[state.curWheel].length}/${cfg.nAccept}`;
    logLine(`[${state.curWheel}] トー採用=${toe.toFixed(3)}° (r_b=${sep.r_b_cm.toFixed(1)}cm res=${sep.residual.toFixed(2)}µT)`);
    setStatus(`[${WLAB[state.curWheel]}] 採用 ${state.accepted[state.curWheel].length}/${cfg.nAccept} トー=${toe.toFixed(2)}°`);
    if(state.accepted[state.curWheel].length>=cfg.nAccept) finalizeWheel();
    else setStatus(`もう1回: 水準1(${cfg.slideOffsets[0]}cm)から「スライド計測」`);
  }

  function finalizeWheel(){
    const t=E.stats(state.accepted[state.curWheel]);
    const c=E.stats(state.camber[state.curWheel]);
    state.results[state.curWheel]={ wheel:state.curWheel, toe_deg:t.mean, toe_sd:t.sd,
      camber_deg:c.mean, camber_sd:c.sd, n_accepted:t.n };
    logLine(`★[${state.curWheel}] 確定 トー=${t.mean.toFixed(2)}±${t.sd.toFixed(2)}° cam=${c.mean.toFixed(2)}°`);
    setStatus(`[${WLAB[state.curWheel]}] 確定。次の輪を選択`);
    renderResults();
  }

  function renderResults(){
    let h='<table><thead><tr><th>輪</th><th>キャンバー</th><th>トー(絶対)</th><th>1σ</th><th>n</th></tr></thead><tbody>';
    for(const w of WHEELS){ const r=state.results[w];
      h += r ? `<tr><td>${WLAB[w]}</td><td>${r.camber_deg.toFixed(2)}°</td><td>${r.toe_deg.toFixed(2)}°</td><td>±${r.toe_sd.toFixed(2)}</td><td>${r.n_accepted}</td></tr>`
             : `<tr class="pending"><td>${WLAB[w]}</td><td>—</td><td>—</td><td>—</td><td>0</td></tr>`; }
    h+='</tbody></table>';
    if(WHEELS.every(w=>state.results[w])){
      const toes={}; WHEELS.forEach(w=>toes[w]=state.results[w].toe_deg);
      const d=E.derived(toes);
      h+=`<div class="derived">`
        +`<div><span>フロント総トー</span><b>${d.front_total_toe_deg.toFixed(2)}°</b> (${E.degToMm(d.front_total_toe_deg).toFixed(1)}mm)</div>`
        +`<div><span>リア総トー</span><b>${d.rear_total_toe_deg.toFixed(2)}°</b></div>`
        +`<div><span>スラスト角</span><b>${d.thrust_angle_deg.toFixed(2)}°</b></div>`
        +`<div><span>スラストライン基準前トー</span><b>${d.front_toe_vs_thrust_deg.toFixed(2)}°</b></div>`
        +`</div>`;
    }
    el.results.innerHTML=h;
  }

  function exportCSV(){
    const resRows=WHEELS.filter(w=>state.results[w]).map(w=>state.results[w]);
    let derivedRow={};
    if(WHEELS.every(w=>state.results[w])){ const toes={}; WHEELS.forEach(w=>toes[w]=state.results[w].toe_deg); derivedRow=E.derived(toes); }
    const resCSV=E.toCSV(resRows,['wheel','camber_deg','camber_sd','toe_deg','toe_sd','n_accepted']);
    const rawCSV=E.toCSV(state.rawlog,['t_ms','phase','wheel','level','ax','ay','az','mx','my','mz']);
    const meta=[
      '# static-magnetic absolute toe  '+new Date().toISOString(),
      '# calibration='+(state.cal?('offset='+JSON.stringify(state.cal.offset.map(x=>+x.toFixed(2)))+' res='+state.cal.residualPct.toFixed(2)+'%'):'none(uncalibrated)'),
      '# vehicleAz='+(state.vehicleAz!=null?state.vehicleAz.toFixed(3):'-')
        +' slideOffsets='+JSON.stringify(cfg.slideOffsets)+' nAccept='+cfg.nAccept,
      '# derived: '+JSON.stringify(derivedRow),
      '','## results',resCSV,'','## rawlog',rawCSV,''
    ].join('\n');
    const blob=new Blob([meta],{type:'text/csv'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='align_mag_'+Date.now()+'.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    logLine('CSVエクスポート完了');
  }

  function resetWheel(){
    state.slide[state.curWheel]=[]; state.accepted[state.curWheel]=[]; state.camber[state.curWheel]=[];
    state.curLevel=0; el.level.textContent=`1/${cfg.slideOffsets.length}`;
    el.acceptCount.textContent=`0/${cfg.nAccept}`;
    setStatus(`[${WLAB[state.curWheel]}] をリセット`);
  }
  function resetAll(){
    WHEELS.forEach(w=>{ state.slide[w]=[]; state.accepted[w]=[]; state.camber[w]=[]; delete state.results[w]; });
    state.rawlog=[]; state.curLevel=0;
    el.acceptCount.textContent=`0/${cfg.nAccept}`; el.level.textContent=`1/${cfg.slideOffsets.length}`;
    renderResults(); setStatus('全リセット'); logLine('全リセット');
  }

  function bind(){
    el.permBtn.onclick=requestPerm;
    el.startBtn.onclick=startSensors;
    el.calBtn.onclick=startCal;
    el.calClearBtn.onclick=clearCal;
    el.vehBtn.onclick=takeVehicle;
    el.slideBtn.onclick=measureSlide;
    el.resetWheelBtn.onclick=resetWheel;
    el.csvBtn.onclick=exportCSV;
    el.resetBtn.onclick=resetAll;
    el.wheelSel.onchange=()=>{
      state.curWheel=el.wheelSel.value; state.curLevel=0;
      el.wheel.textContent=WLAB[state.curWheel];
      el.level.textContent=`1/${cfg.slideOffsets.length}`;
      el.acceptCount.textContent=`${state.accepted[state.curWheel].length}/${cfg.nAccept}`;
      setStatus('対象輪: '+WLAB[state.curWheel]);
    };
    el.offsets.textContent=cfg.slideOffsets.join(' / ')+' cm';
    el.wheel.textContent=WLAB[state.curWheel];
    el.level.textContent=`1/${cfg.slideOffsets.length}`;
    el.acceptCount.textContent=`0/${cfg.nAccept}`;
    renderResults();
  }
  async function keepAwake(){ try{ if('wakeLock' in navigator) await navigator.wakeLock.request('screen'); }catch(e){} }
  window.addEventListener('DOMContentLoaded',()=>{ bind(); keepAwake(); setStatus('「権限」→「センサ起動」から'); });
})();
