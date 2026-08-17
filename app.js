/* =====================================================================
 * app.js  —  計測ステートマシン / セッション管理 / UI配線（v2）
 *   変更点: 「押し開始→(ゆっくり転がす)→停止＆判定」方式。
 *           estimateFromRollV2（スピン補正+速度/変位+ZUPT）を使用。
 *   依存: estimator.js (window.Estimator), sensors.js (window.Sensors)
 * ===================================================================== */
(function () {
  'use strict';
  const E = window.Estimator;
  const { SensorHub } = window.Sensors;

  const WHEELS = ['FL', 'FR', 'RL', 'RR'];
  const WHEEL_LABEL = { FL: '前左 FL', FR: '前右 FR', RL: '後左 RL', RR: '後右 RR' };

  // ------- 設定（UIから変更可）-------
  const cfg = {
    curveThreshDeg: 2.0,  // 直進ゲート: 軌跡の曲がり角上限
    minDisp_m: 0.05,      // 直進ゲート: 最小到達変位 [m]（既定5cm）
    nAccept: 3,           // 各輪の採用回数
    staticMs: 1500,       // 静止取得時間
    maxRollMs: 10000,     // 押しの最大時間（安全停止）
  };

  // ------- 状態 -------
  const state = {
    hub: new SensorHub(),
    phase: 'idle',       // idle | static | armed | rolling | done
    wheel: 'FL',
    gyroBias: [0, 0, 0],
    accelStatic: [0, 0, 9.81],
    buffer: [],
    accepted: {}, camber: {}, results: {}, rawlog: [],
    lastEffHz: 0,
  };
  WHEELS.forEach(w => { state.accepted[w] = []; state.camber[w] = []; });

  // ------- DOM -------
  const $ = (id) => document.getElementById(id);
  const el = {};
  ['status','effhz','mode','wheel','phase','liveCamber','liveDisp','liveCurve',
   'acceptCount','log','startBtn','staticBtn','rollStartBtn','rollStopBtn',
   'resetBtn','csvBtn','wheelSel','curveThresh','minDisp','nAccept','results','permBtn']
   .forEach(id => el[id] = $(id));

  function logLine(s) {
    const t = new Date().toLocaleTimeString();
    el.log.textContent = `[${t}] ${s}\n` + el.log.textContent;
  }
  function setStatus(s) { el.status.textContent = s; }
  const f = (x) => Math.round(x * 1000) / 1000;

  // ------- センサ購読 -------
  let rollTimer = null;
  function onSample(sample) {
    if (state.phase === 'rolling' || state.phase === 'static') {
      state.rawlog.push({
        t_ms: Math.round(sample.t_ms), wheel: state.wheel, phase: state.phase,
        ax: f(sample.accel[0]), ay: f(sample.accel[1]), az: f(sample.accel[2]),
        lx: f(sample.lin[0]), ly: f(sample.lin[1]), lz: f(sample.lin[2]),
        gx: f(sample.gyro[0]), gy: f(sample.gyro[1]), gz: f(sample.gyro[2]),
      });
    }
    if (state.phase === 'static') {
      state._sA.push(sample.accel); state._sG.push(sample.gyro);
    } else if (state.phase === 'rolling') {
      state.buffer.push(sample);
    }
    // ライブ: 静止キャンバー & 実効Hz
    el.liveCamber.textContent = E.camberStatic(sample.accel, [0, 0, 1]).toFixed(2) + '°';
    state.lastEffHz = state.hub.effectiveHz;
    el.effhz.textContent = state.lastEffHz.toFixed(0) + ' Hz';
  }

  // ------- フロー -------
  async function requestPerm() {
    const ok = await SensorHub.requestPermission();
    logLine(ok ? '権限OK' : '権限が拒否されました');
  }

  async function startSensors() {
    try {
      const mode = await state.hub.start(onSample);
      el.mode.textContent = mode;
      setStatus('センサ起動: ' + mode + '（治具で端末をハブ中心に固定）');
      logLine('センサ起動 mode=' + mode);
      el.startBtn.disabled = true;
      el.staticBtn.disabled = false;
    } catch (e) {
      setStatus('センサ起動失敗: ' + e.message);
      logLine('起動失敗: ' + e.message);
    }
  }

  function takeStatic() {
    state.phase = 'static'; state._sA = []; state._sG = [];
    el.phase.textContent = '静止取得中…';
    setStatus('静止取得中… 端末を動かさないでください');
    setTimeout(() => {
      const A = E.V.mean(state._sA), Gb = E.V.mean(state._sG);
      state.accelStatic = A; state.gyroBias = Gb;
      const cam = E.camberStatic(A, [0, 0, 1]);
      state.phase = 'armed';
      el.phase.textContent = '準備OK';
      setStatus(`静止取得完了 キャンバー=${cam.toFixed(2)}°  ②押し開始→ゆっくり転がす→③停止`);
      logLine(`[${state.wheel}] static camber=${cam.toFixed(2)}°`);
      el.rollStartBtn.disabled = false;
      el.rollStopBtn.disabled = true;
    }, cfg.staticMs);
  }

  function rollStart() {
    if (state.phase !== 'armed') { setStatus('先に①静止取得を行ってください'); return; }
    state.phase = 'rolling'; state.buffer = [];
    el.phase.textContent = '計測中…（ゆっくりでOK）';
    setStatus('計測中… 前後どちらかへゆっくり転がし、止めたら③停止');
    el.liveDisp.textContent = '計測中';
    el.rollStartBtn.disabled = true;
    el.rollStopBtn.disabled = false;
    rollTimer = setTimeout(() => { if (state.phase === 'rolling') { logLine('最大時間で自動停止'); rollStop(); } }, cfg.maxRollMs);
  }

  function rollStop() {
    if (state.phase !== 'rolling') return;
    if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; }
    const samples = state.buffer.slice();
    state.phase = 'armed';
    el.rollStartBtn.disabled = false;
    el.rollStopBtn.disabled = true;

    if (samples.length < 20) {
      setStatus('サンプル不足。もう一度②から'); logLine('停止: サンプル不足 n=' + samples.length); return;
    }
    const res = E.estimateFromRollV2(samples, state.accelStatic, state.gyroBias);
    const gate = E.straightGateV2(res, cfg);
    el.liveDisp.textContent = (res.disp_m * 100).toFixed(1) + 'cm';
    el.liveCurve.textContent = res.curve_deg.toFixed(2) + '°';

    if (gate.accepted) {
      state.accepted[state.wheel].push(res.toe_deg);
      state.camber[state.wheel].push(res.camber_deg);
      logLine(`[${state.wheel}] 採用 toe=${res.toe_deg.toFixed(2)}° cam=${res.camber_deg.toFixed(2)}° 変位=${(res.disp_m*100).toFixed(0)}cm 曲=${res.curve_deg.toFixed(2)}° スピン=${res.spinAngle_deg.toFixed(0)}°`);
      setStatus(`採用 (${state.accepted[state.wheel].length}/${cfg.nAccept}) toe=${res.toe_deg.toFixed(2)}°`);
    } else {
      const why = gate.reason === 'curved'
        ? `曲がりました(${res.curve_deg.toFixed(1)}°>${cfg.curveThreshDeg}°)`
        : `動きが小さい(${(res.disp_m*100).toFixed(0)}cm<${(cfg.minDisp_m*100).toFixed(0)}cm)`;
      logLine(`[${state.wheel}] 棄却 ${why}`);
      setStatus(`やり直し: ${why}`);
    }
    el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;
    if (state.accepted[state.wheel].length >= cfg.nAccept) finalizeWheel();
  }

  function finalizeWheel() {
    const toe = E.stats(state.accepted[state.wheel]);
    const cam = E.stats(state.camber[state.wheel]);
    state.results[state.wheel] = {
      wheel: state.wheel, toe_deg: toe.mean, toe_sd: toe.sd,
      camber_deg: cam.mean, camber_sd: cam.sd, n_accepted: toe.n,
    };
    logLine(`★ [${state.wheel}] 確定 toe=${toe.mean.toFixed(2)}±${toe.sd.toFixed(2)}° cam=${cam.mean.toFixed(2)}°`);
    setStatus(`[${state.wheel}] 確定。次の輪を選択`);
    renderResults();
  }

  function renderResults() {
    let html = '<table><thead><tr><th>輪</th><th>キャンバー</th><th>トー</th><th>1σ</th><th>n</th></tr></thead><tbody>';
    for (const w of WHEELS) {
      const r = state.results[w];
      html += r
        ? `<tr><td>${WHEEL_LABEL[w]}</td><td>${r.camber_deg.toFixed(2)}°</td><td>${r.toe_deg.toFixed(2)}°</td><td>±${r.toe_sd.toFixed(2)}</td><td>${r.n_accepted}</td></tr>`
        : `<tr class="pending"><td>${WHEEL_LABEL[w]}</td><td>—</td><td>—</td><td>—</td><td>0</td></tr>`;
    }
    html += '</tbody></table>';
    if (WHEELS.every(w => state.results[w])) {
      const toes = {}; WHEELS.forEach(w => toes[w] = state.results[w].toe_deg);
      const d = E.derived(toes);
      html += `<div class="derived">`
        + `<div><span>フロント総トー</span><b>${d.front_total_toe_deg.toFixed(2)}°</b> (${E.degToMm(d.front_total_toe_deg).toFixed(1)}mm)</div>`
        + `<div><span>リア総トー</span><b>${d.rear_total_toe_deg.toFixed(2)}°</b></div>`
        + `<div><span>スラスト角</span><b>${d.thrust_angle_deg.toFixed(2)}°</b></div>`
        + `<div><span>スラストライン基準前トー</span><b>${d.front_toe_vs_thrust_deg.toFixed(2)}°</b></div>`
        + `</div>`;
    }
    el.results.innerHTML = html;
  }

  // ------- CSV -------
  function exportCSV() {
    const resRows = WHEELS.filter(w => state.results[w]).map(w => state.results[w]);
    let derivedRow = {};
    if (WHEELS.every(w => state.results[w])) {
      const toes = {}; WHEELS.forEach(w => toes[w] = state.results[w].toe_deg);
      derivedRow = E.derived(toes);
    }
    const resCSV = E.toCSV(resRows, ['wheel','camber_deg','camber_sd','toe_deg','toe_sd','n_accepted']);
    const rawCSV = E.toCSV(state.rawlog, ['t_ms','wheel','phase','ax','ay','az','lx','ly','lz','gx','gy','gz']);
    const meta = [
      '# alignment session ' + new Date().toISOString(),
      '# method: translation-reference v2 (spin-corrected, velocity/ZUPT)',
      '# cfg: curveThresh=' + cfg.curveThreshDeg + ' minDisp_m=' + cfg.minDisp_m +
      ' nAccept=' + cfg.nAccept + ' effHz=' + state.lastEffHz.toFixed(0),
      '# derived: ' + JSON.stringify(derivedRow),
      '', '## results', resCSV, '', '## rawlog', rawCSV, ''
    ].join('\n');
    download('alignment_' + Date.now() + '.csv', meta);
    logLine('CSVエクスポート完了');
  }
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function resetSession() {
    WHEELS.forEach(w => { state.accepted[w] = []; state.camber[w] = []; delete state.results[w]; });
    state.rawlog = [];
    el.acceptCount.textContent = `0/${cfg.nAccept}`;
    renderResults(); setStatus('リセットしました'); logLine('セッションリセット');
  }

  // ------- 配線 -------
  function bind() {
    el.permBtn.onclick = requestPerm;
    el.startBtn.onclick = startSensors;
    el.staticBtn.onclick = takeStatic;
    el.rollStartBtn.onclick = rollStart;
    el.rollStopBtn.onclick = rollStop;
    el.resetBtn.onclick = resetSession;
    el.csvBtn.onclick = exportCSV;
    el.wheelSel.onchange = () => {
      state.wheel = el.wheelSel.value;
      el.wheel.textContent = WHEEL_LABEL[state.wheel];
      el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;
      setStatus('対象輪: ' + WHEEL_LABEL[state.wheel]);
    };
    el.curveThresh.oninput = () => {
      cfg.curveThreshDeg = parseFloat(el.curveThresh.value);
      $('curveThreshVal').textContent = cfg.curveThreshDeg.toFixed(1);
    };
    el.minDisp.oninput = () => {
      cfg.minDisp_m = parseInt(el.minDisp.value, 10) / 100;
      $('minDispVal').textContent = (cfg.minDisp_m * 100).toFixed(0);
    };
    el.nAccept.oninput = () => {
      cfg.nAccept = parseInt(el.nAccept.value, 10);
      $('nAcceptVal').textContent = cfg.nAccept;
      el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;
    };
    el.wheel.textContent = WHEEL_LABEL[state.wheel];
    el.acceptCount.textContent = `0/${cfg.nAccept}`;
    renderResults();
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  window.addEventListener('DOMContentLoaded', () => {
    bind(); keepAwake();
    setStatus('「権限」→「センサ起動」から開始してください');
  });
})();
