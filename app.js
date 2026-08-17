/* =====================================================================
 * app.js  —  計測ステートマシン / セッション管理 / UI配線
 * ---------------------------------------------------------------------
 * 依存: estimator.js (window.Estimator), sensors.js (window.Sensors)
 * ===================================================================== */
(function () {
  'use strict';
  const E = window.Estimator;
  const { SensorHub } = window.Sensors;

  const WHEELS = ['FL', 'FR', 'RL', 'RR'];
  const WHEEL_LABEL = { FL: '前左 FL', FR: '前右 FR', RL: '後左 RL', RR: '後右 RR' };

  // ------- 設定（UIから変更可）-------
  const cfg = {
    yawThreshDeg: 1.0,   // 直進ゲート閾値（広がり指標）
    minTransAccel: 0.6,  // 最小並進加速度 [m/s^2]
    nAccept: 3,          // 各輪の採用回数
    staticMs: 1500,      // 静止取得時間
  };

  // ------- 状態 -------
  const state = {
    hub: new SensorHub(),
    phase: 'idle',       // idle | static | armed | rolling | done
    wheel: 'FL',
    gyroBias: [0, 0, 0],
    accelStatic: [0, 0, 9.81],
    buffer: [],          // rolling中のサンプル
    accepted: {},        // wheel -> [toe...]
    camber: {},          // wheel -> [camber...]
    results: {},         // wheel -> {toe, camber, ...}
    rawlog: [],          // 全生ログ
    lastEffHz: 0,
  };
  WHEELS.forEach(w => { state.accepted[w] = []; state.camber[w] = []; });

  // ------- DOM -------
  const $ = (id) => document.getElementById(id);
  const el = {};
  ['status','effhz','mode','wheel','phase','liveCamber','liveGate',
   'acceptCount','log','startBtn','staticBtn','armBtn','resetBtn','csvBtn',
   'wheelSel','yawThresh','nAccept','results','permBtn'].forEach(id => el[id] = $(id));

  function logLine(s) {
    const t = new Date().toLocaleTimeString();
    el.log.textContent = `[${t}] ${s}\n` + el.log.textContent;
  }
  function setStatus(s) { el.status.textContent = s; }

  // ------- センサ購読 -------
  let rollingStart = 0;
  function onSample(sample) {
    // 生ログ（rolling中のみ保存して肥大化防止）
    if (state.phase === 'rolling' || state.phase === 'static') {
      state.rawlog.push({
        t_ms: Math.round(sample.t_ms), wheel: state.wheel, phase: state.phase,
        ax: f(sample.accel[0]), ay: f(sample.accel[1]), az: f(sample.accel[2]),
        lx: f(sample.lin[0]), ly: f(sample.lin[1]), lz: f(sample.lin[2]),
        gx: f(sample.gyro[0]), gy: f(sample.gyro[1]), gz: f(sample.gyro[2]),
      });
    }

    if (state.phase === 'static') {
      state._staticAccel.push(sample.accel);
      state._staticGyro.push(sample.gyro);
    } else if (state.phase === 'rolling') {
      state.buffer.push(sample);
    }

    // ライブ表示（キャンバー: 静止治具仮定）
    const camNow = E.camberStatic(sample.accel, [0, 0, 1]);
    el.liveCamber.textContent = camNow.toFixed(2) + '°';
    state.lastEffHz = state.hub.effectiveHz;
    el.effhz.textContent = state.lastEffHz.toFixed(0) + ' Hz';
  }
  const f = (x) => Math.round(x * 1000) / 1000;

  // ------- フロー -------
  async function requestPerm() {
    const ok = await SensorHub.requestPermission();
    logLine(ok ? '権限OK' : '権限が拒否されました');
  }

  async function startSensors() {
    try {
      const mode = await state.hub.start(onSample);
      el.mode.textContent = mode;
      setStatus('センサ起動: ' + mode + '（治具で端末をハブに固定してください）');
      logLine('センサ起動 mode=' + mode);
      el.startBtn.disabled = true;
      el.staticBtn.disabled = false;
    } catch (e) {
      setStatus('センサ起動失敗: ' + e.message);
      logLine('起動失敗: ' + e.message);
    }
  }

  function takeStatic() {
    state.phase = 'static';
    state._staticAccel = [];
    state._staticGyro = [];
    el.phase.textContent = '静止取得中…';
    setStatus('静止取得中… 端末を動かさないでください');
    setTimeout(() => {
      const A = E.V.mean(state._staticAccel);
      const Gb = E.V.mean(state._staticGyro);
      state.accelStatic = A;
      state.gyroBias = Gb;
      // 静止キャンバーを記録
      const cam = E.camberStatic(A, [0, 0, 1]);
      state.camber[state.wheel].push(cam);
      state.phase = 'armed';
      el.phase.textContent = '準備OK（押してください）';
      setStatus(`静止取得完了. キャンバー=${cam.toFixed(2)}°  次に前後へ短く押す`);
      logLine(`[${state.wheel}] static: camber=${cam.toFixed(2)}° gyroBias=[${Gb.map(x=>x.toExponential(1)).join(',')}]`);
      el.armBtn.disabled = false;
    }, cfg.staticMs);
  }

  function armRoll() {
    if (state.phase !== 'armed' && state.phase !== 'rolling') {
      setStatus('先に静止取得を行ってください');
      return;
    }
    state.phase = 'rolling';
    state.buffer = [];
    rollingStart = performance.now();
    el.phase.textContent = '計測中…（前後に短く強く）';
    setStatus('押しを計測中… 2秒後に自動判定');
    // 2秒間バッファリング → 判定
    setTimeout(evaluatePush, 2000);
  }

  function evaluatePush() {
    if (state.phase !== 'rolling') return;
    const samples = state.buffer.slice();
    state.phase = 'armed';
    if (samples.length < 20) {
      setStatus('サンプル不足。もう一度押してください');
      logLine('push: サンプル不足 n=' + samples.length);
      return;
    }
    const res = E.estimateFromRoll(samples, state.accelStatic, state.gyroBias);
    const gate = E.straightGate(res, cfg);
    el.liveGate.textContent = res.dyaw_deg.toFixed(2);
    if (gate.accepted) {
      state.accepted[state.wheel].push(res.toe_deg);
      state.camber[state.wheel].push(res.camber_deg);
      logLine(`[${state.wheel}] 採用 toe=${res.toe_deg.toFixed(2)}° camber=${res.camber_deg.toFixed(2)}° 広がり=${res.dyaw_deg.toFixed(2)}`);
      setStatus(`採用 (${state.accepted[state.wheel].length}/${cfg.nAccept}) toe=${res.toe_deg.toFixed(2)}°`);
    } else {
      const why = gate.reason === 'curved' ? '曲がりました' : '押しが弱い';
      logLine(`[${state.wheel}] 棄却(${why}) 広がり=${res.dyaw_deg.toFixed(2)} 強さ=${res.transStrength.toFixed(2)}`);
      setStatus(`やり直し: ${why}（広がり=${res.dyaw_deg.toFixed(2)}°）`);
    }
    el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;

    if (state.accepted[state.wheel].length >= cfg.nAccept) {
      finalizeWheel();
    }
  }

  function finalizeWheel() {
    const toe = E.stats(state.accepted[state.wheel]);
    const cam = E.stats(state.camber[state.wheel]);
    state.results[state.wheel] = {
      wheel: state.wheel,
      toe_deg: toe.mean, toe_sd: toe.sd,
      camber_deg: cam.mean, camber_sd: cam.sd,
      n_accepted: toe.n,
    };
    logLine(`★ [${state.wheel}] 確定 toe=${toe.mean.toFixed(2)}±${toe.sd.toFixed(2)}° camber=${cam.mean.toFixed(2)}°`);
    setStatus(`[${state.wheel}] 確定。次の輪を選択してください`);
    renderResults();
  }

  function renderResults() {
    let html = '<table><thead><tr><th>輪</th><th>キャンバー</th><th>トー</th><th>1σ</th><th>n</th></tr></thead><tbody>';
    for (const w of WHEELS) {
      const r = state.results[w];
      if (r) {
        html += `<tr><td>${WHEEL_LABEL[w]}</td><td>${r.camber_deg.toFixed(2)}°</td>`
             + `<td>${r.toe_deg.toFixed(2)}°</td><td>±${r.toe_sd.toFixed(2)}</td><td>${r.n_accepted}</td></tr>`;
      } else {
        html += `<tr class="pending"><td>${WHEEL_LABEL[w]}</td><td>—</td><td>—</td><td>—</td><td>0</td></tr>`;
      }
    }
    html += '</tbody></table>';

    // 派生量（4輪揃ったら）
    if (WHEELS.every(w => state.results[w])) {
      const toes = {};
      WHEELS.forEach(w => toes[w] = state.results[w].toe_deg);
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
    // 結果CSV
    const resRows = WHEELS.filter(w => state.results[w]).map(w => state.results[w]);
    let derivedRow = {};
    if (WHEELS.every(w => state.results[w])) {
      const toes = {}; WHEELS.forEach(w => toes[w] = state.results[w].toe_deg);
      derivedRow = E.derived(toes);
    }
    const resCSV = E.toCSV(resRows,
      ['wheel','camber_deg','camber_sd','toe_deg','toe_sd','n_accepted']);
    const rawCSV = E.toCSV(state.rawlog,
      ['t_ms','wheel','phase','ax','ay','az','lx','ly','lz','gx','gy','gz']);

    const meta = [
      '# alignment session ' + new Date().toISOString(),
      '# cfg: yawThresh=' + cfg.yawThreshDeg + ' nAccept=' + cfg.nAccept +
      ' minTransAccel=' + cfg.minTransAccel + ' effHz=' + state.lastEffHz.toFixed(0),
      '# derived: ' + JSON.stringify(derivedRow),
      '', '## results', resCSV, '', '## rawlog', rawCSV, ''
    ].join('\n');

    download('alignment_' + Date.now() + '.csv', meta);
    logLine('CSVエクスポート完了');
  }
  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function resetSession() {
    WHEELS.forEach(w => { state.accepted[w] = []; state.camber[w] = []; delete state.results[w]; });
    state.rawlog = [];
    el.acceptCount.textContent = `0/${cfg.nAccept}`;
    renderResults();
    setStatus('リセットしました');
    logLine('セッションリセット');
  }

  // ------- 配線 -------
  function bind() {
    el.permBtn.onclick = requestPerm;
    el.startBtn.onclick = startSensors;
    el.staticBtn.onclick = takeStatic;
    el.armBtn.onclick = armRoll;
    el.resetBtn.onclick = resetSession;
    el.csvBtn.onclick = exportCSV;
    el.wheelSel.onchange = () => {
      state.wheel = el.wheelSel.value;
      el.wheel.textContent = WHEEL_LABEL[state.wheel];
      el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;
      setStatus('対象輪: ' + WHEEL_LABEL[state.wheel]);
    };
    el.yawThresh.oninput = () => {
      cfg.yawThreshDeg = parseFloat(el.yawThresh.value);
      document.getElementById('yawThreshVal').textContent = cfg.yawThreshDeg.toFixed(2);
    };
    el.nAccept.oninput = () => {
      cfg.nAccept = parseInt(el.nAccept.value, 10);
      document.getElementById('nAcceptVal').textContent = cfg.nAccept;
      el.acceptCount.textContent = `${state.accepted[state.wheel].length}/${cfg.nAccept}`;
    };
    el.wheel.textContent = WHEEL_LABEL[state.wheel];
    el.acceptCount.textContent = `0/${cfg.nAccept}`;
    renderResults();
  }

  // Wake Lock（画面常時点灯）
  async function keepAwake() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); }
    catch (e) { /* noop */ }
  }

  window.addEventListener('DOMContentLoaded', () => {
    bind();
    keepAwake();
    setStatus('「権限」→「センサ起動」から開始してください');
  });
})();
