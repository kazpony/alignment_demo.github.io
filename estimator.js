/* =====================================================================
 * estimator.js  —  並進基準法アライメント計測の信号処理コア
 * ---------------------------------------------------------------------
 * 依存なし（ブラウザ / Node 双方で動く純粋関数群）。
 *
 * v2 の主眼: 「ゆっくり・長め」の押しを許容する。
 *   1) スピン補正: 端末はホイールと一緒にスピンするため、線形加速度を
 *      スピン角ぶん逆回転して安定フレームへ戻す（回転塗り潰し対策）。
 *   2) 速度/変位ベース: 加速度PCAではなく積分した速度・変位の向きで
 *      並進方向を取る（低速でSNRに強い）。
 *   3) ZUPT: 押しの開始/終了が静止である前提で速度をデトレンドし、
 *      バイアスドリフトを除去（ゆっくり長い押しでも安定）。
 *   ゲートは軌跡の「曲がり角」（スケール非依存）で判定。
 * ===================================================================== */
(function (global) {
  'use strict';

  // ---- 3次元ベクトル基本演算 -------------------------------------
  const V = {
    add: (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
    sub: (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]],
    scale: (a, s) => [a[0]*s, a[1]*s, a[2]*s],
    dot: (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
    cross: (a, b) => [
      a[1]*b[2] - a[2]*b[1],
      a[2]*b[0] - a[0]*b[2],
      a[0]*b[1] - a[1]*b[0],
    ],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => {
      const n = Math.hypot(a[0], a[1], a[2]);
      return n > 1e-12 ? [a[0]/n, a[1]/n, a[2]/n] : [0, 0, 0];
    },
    mean: (arr) => {
      const s = [0, 0, 0];
      for (const v of arr) { s[0]+=v[0]; s[1]+=v[1]; s[2]+=v[2]; }
      const n = arr.length || 1;
      return [s[0]/n, s[1]/n, s[2]/n];
    },
  };

  const DEG = Math.PI / 180, RAD = 180 / Math.PI;

  // ---- Rodrigues: 単位軸 axis まわりに角 ang[rad] だけ v を回転 ----
  function rotateAxis(v, axis, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const cr = V.cross(axis, v);
    const d = V.dot(axis, v) * (1 - c);
    return [
      v[0]*c + cr[0]*s + axis[0]*d,
      v[1]*c + cr[1]*s + axis[1]*d,
      v[2]*c + cr[2]*s + axis[2]*d,
    ];
  }

  // ---- 対称3x3の最大固有ベクトル（べき乗法; PCA用, 旧v1で使用）----
  function principalAxis(vectors) {
    const mu = V.mean(vectors);
    let cxx=0, cxy=0, cxz=0, cyy=0, cyz=0, czz=0;
    for (const v of vectors) {
      const d0=v[0]-mu[0], d1=v[1]-mu[1], d2=v[2]-mu[2];
      cxx+=d0*d0; cxy+=d0*d1; cxz+=d0*d2;
      cyy+=d1*d1; cyz+=d1*d2; czz+=d2*d2;
    }
    const C = [[cxx,cxy,cxz],[cxy,cyy,cyz],[cxz,cyz,czz]];
    let b = V.unit([1, 0.3, -0.2]);
    for (let it=0; it<64; it++) {
      const nb = [
        C[0][0]*b[0]+C[0][1]*b[1]+C[0][2]*b[2],
        C[1][0]*b[0]+C[1][1]*b[1]+C[1][2]*b[2],
        C[2][0]*b[0]+C[2][1]*b[1]+C[2][2]*b[2],
      ];
      const u = V.unit(nb);
      if (V.norm(V.sub(u, b)) < 1e-9) { b = u; break; }
      b = u;
    }
    return b;
  }

  // ---- 台形積分（スカラー列）------------------------------------
  function integrate(values, times_ms) {
    let acc = 0;
    for (let i = 1; i < values.length; i++) {
      const dt = (times_ms[i] - times_ms[i-1]) / 1000;
      acc += 0.5 * (values[i] + values[i-1]) * dt;
    }
    return acc;
  }

  // ---- 台形積分（ベクトル列 → 累積ベクトル列）------------------
  function integrateVecCumulative(vecs, times_ms) {
    const out = [[0,0,0]];
    for (let i = 1; i < vecs.length; i++) {
      const dt = (times_ms[i] - times_ms[i-1]) / 1000;
      const inc = V.scale(V.add(vecs[i], vecs[i-1]), 0.5 * dt);
      out.push(V.add(out[i-1], inc));
    }
    return out;
  }

  /* -----------------------------------------------------------------
   * キャンバー（静止・治具仮定）
   * --------------------------------------------------------------- */
  function camberStatic(accelStatic, wheelNormalSensor) {
    const up = V.unit(accelStatic);
    const s = V.unit(wheelNormalSensor || [0, 0, 1]);
    return Math.asin(Math.max(-1, Math.min(1, V.dot(s, up)))) * RAD;
  }

  /* =================================================================
   * v2: スピン補正 + 速度/変位ベース + ZUPT
   *   samples: { gyro:[rad/s], lin:[m/s^2], t_ms } の配列（押し全体）
   *   accelStatic: 静止加速度平均（up算出用）
   *   gyroBias:    静止ジャイロバイアス [rad/s]
   *   opts: { wheelRadius_m? }  （将来: レバーアーム補正等）
   * 戻り: {
   *   toe_deg, camber_deg,
   *   curve_deg,      // 軌跡の曲がり角（ゲート用, スケール非依存）
   *   disp_m,         // 到達変位の大きさ [m]（ゲート用）
   *   spinAngle_deg,  // 押し中に端末が回った総スピン角（参考）
   *   peakSpeed       // 参考: 速度ピーク [m/s]
   * }
   * ================================================================= */
  function estimateFromRollV2(samples, accelStatic, gyroBias, opts) {
    opts = opts || {};
    const up = V.unit(accelStatic);
    const bias = gyroBias || [0, 0, 0];
    const N = samples.length;

    const gyros = samples.map(s => V.sub(s.gyro, bias));
    const lins  = samples.map(s => s.lin);
    const times = samples.map(s => s.t_ms);

    // --- スピン軸 s（端末座標, 平均角速度方向）とキャンバー ---
    const gmean = V.mean(gyros);
    const s = V.unit(gmean);
    const camber = Math.asin(Math.max(-1, Math.min(1, V.dot(s, up)))) * RAD;

    // --- スピン角 φ(t) = ∫ (ω·s) dt （端末が軸まわりに回った角度）---
    const spinRate = gyros.map(g => V.dot(g, s)); // rad/s
    const phi = [0];
    for (let i = 1; i < N; i++) {
      const dt = (times[i] - times[i-1]) / 1000;
      phi.push(phi[i-1] + 0.5 * (spinRate[i] + spinRate[i-1]) * dt);
    }
    const spinAngle_deg = Math.abs(phi[N-1]) * RAD;

    // --- 線形加速度をスピン角ぶん逆回転し、押し開始フレームへ戻す ---
    //   端末→世界回転が軸sまわりに R(s, φ) で進むので、+φ回転で戻す。
    const linDerot = lins.map((l, i) => rotateAxis(l, s, phi[i]));

    // --- 速度に積分 → ZUPT（開始/終了=静止 の前提で線形デトレンド）---
    let vel = integrateVecCumulative(linDerot, times);
    const vEnd = vel[N-1];
    vel = vel.map((v, i) => {
      const k = (N > 1) ? i / (N - 1) : 0;
      return V.sub(v, V.scale(vEnd, k)); // v(0)=0, v(N-1)=0 を強制
    });
    let peakSpeed = 0;
    for (const v of vel) { const sp = V.norm(v); if (sp > peakSpeed) peakSpeed = sp; }

    // --- 変位に積分 → 水平面へ射影 ---
    const disp = integrateVecCumulative(vel, times);
    const dispH = disp.map(p => V.sub(p, V.scale(up, V.dot(p, up))));

    // 最遠点（開始からの水平変位が最大の点）を進行の代表方向に採用
    //   → 「前進して止まる」も「前進して戻る」も頑健に扱える
    let farIdx = 0, farMag = 0;
    for (let i = 0; i < N; i++) {
      const m = V.norm(dispH[i]);
      if (m > farMag) { farMag = m; farIdx = i; }
    }
    const disp_m = farMag;

    // 進行方向 T（水平化）
    const T = V.unit(dispH[farIdx]);

    // --- ホイール進行方位 r = s × up（静止姿勢から定まる）---
    //   s×up の符号は「軸のどちら向きを正とするか」という規約に依存し、
    //   ±180°の曖昧性を生む。ホイール方位と走行方向はトーぶんだけ差の
    //   ほぼ平行なので、進行方向 T と同じ半球へ r を揃える（=微小角に正規化）。
    let r = V.unit(V.cross(s, up));
    if (V.dot(r, T) < 0) r = V.scale(r, -1);

    // --- トー: 前方 T からホイール方位 r への符号付き水平角（微小）---
    const toe = Math.atan2(V.dot(V.cross(T, r), up), V.dot(T, r)) * RAD;

    // --- ゲート: 最遠点までの軌跡の「曲がり角」（スケール非依存）---
    //   速度の向きを前半/後半で比較（低速でも向きは安定）。
    const half = Math.max(1, Math.floor(farIdx / 2));
    const vHoriz = (i) => {
      const v = vel[i];
      return V.sub(v, V.scale(up, V.dot(v, up)));
    };
    let vE = [0,0,0], vL = [0,0,0];
    for (let i = 1; i <= half; i++) vE = V.add(vE, vHoriz(i));
    for (let i = half + 1; i <= farIdx; i++) vL = V.add(vL, vHoriz(i));
    vE = V.unit(vE); vL = V.unit(vL);
    let curve_deg = 0;
    if (V.norm(vE) > 0 && V.norm(vL) > 0) {
      curve_deg = Math.atan2(V.dot(V.cross(vE, vL), up), V.dot(vE, vL)) * RAD;
    }

    return {
      toe_deg: toe,
      camber_deg: camber,
      curve_deg: curve_deg,
      disp_m: disp_m,
      spinAngle_deg: spinAngle_deg,
      peakSpeed: peakSpeed,
    };
  }

  /* -----------------------------------------------------------------
   * v2 用 直進ゲート（変位下限 + 曲がり角上限）
   *   cfg: { curveThreshDeg, minDisp_m }
   * --------------------------------------------------------------- */
  function straightGateV2(res, cfg) {
    const moved = res.disp_m >= cfg.minDisp_m;
    const straight = Math.abs(res.curve_deg) <= cfg.curveThreshDeg;
    let reason = 'ok';
    if (!moved) reason = 'weak';         // 動きが小さすぎる
    else if (!straight) reason = 'curved'; // 曲がった
    return { accepted: moved && straight, reason };
  }

  /* -----------------------------------------------------------------
   * （旧v1: 加速度PCAベース。参照/回帰テスト用に残置）
   * --------------------------------------------------------------- */
  function estimateFromRoll(samples, accelStatic, gyroBias) {
    const up = V.unit(accelStatic);
    const bias = gyroBias || [0, 0, 0];
    const gyros = samples.map(s => V.sub(s.gyro, bias));
    const lins  = samples.map(s => s.lin);
    const gmean = V.mean(gyros);
    const s = V.unit(gmean);
    const spinRate = V.norm(gmean);

    let t = principalAxis(lins);
    const half = Math.max(1, Math.floor(lins.length / 2));
    const front = V.mean(lins.slice(0, half));
    if (V.dot(front, t) < 0) t = V.scale(t, -1);
    const transStrength = V.norm(front);

    const e1 = V.unit(V.sub(t, V.scale(up, V.dot(t, up))));
    const e2 = V.unit(V.cross(up, e1));
    let saa=0, sab=0, sbb=0, ma=0, mb=0;
    for (const l of lins) { const a=V.dot(l,e1), b=V.dot(l,e2); ma+=a; mb+=b; }
    ma/=lins.length; mb/=lins.length;
    for (const l of lins) { const a=V.dot(l,e1)-ma, b=V.dot(l,e2)-mb; saa+=a*a; sab+=a*b; sbb+=b*b; }
    const n=lins.length; saa/=n; sab/=n; sbb/=n;
    const tr=saa+sbb, det=saa*sbb-sab*sab;
    const disc=Math.sqrt(Math.max(0, tr*tr/4-det));
    const lMax=tr/2+disc, lMin=Math.max(0, tr/2-disc);
    const dyaw_deg=Math.atan2(Math.sqrt(lMin), Math.sqrt(lMax))*RAD;

    const f = V.unit(V.sub(t, V.scale(up, V.dot(t, up))));
    const r = V.unit(V.cross(s, up));
    const toe = Math.atan2(V.dot(V.cross(f, r), up), V.dot(f, r)) * RAD;
    const camber = Math.asin(Math.max(-1, Math.min(1, V.dot(s, up)))) * RAD;
    return { toe_deg: toe, camber_deg: camber, dyaw_deg, spinRate, transStrength };
  }
  function straightGate(res, cfg) {
    const yawOk = Math.abs(res.dyaw_deg) <= cfg.yawThreshDeg;
    const snrOk = res.transStrength >= cfg.minTransAccel;
    let reason = 'ok';
    if (!snrOk) reason = 'weak';
    else if (!yawOk) reason = 'curved';
    return { accepted: yawOk && snrOk, reason };
  }

  // ---- 統計 ----------------------------------------------------
  function stats(arr) {
    const n = arr.length;
    if (n === 0) return { mean: NaN, sd: NaN, n: 0 };
    const m = arr.reduce((a, b) => a + b, 0) / n;
    const v = n > 1 ? arr.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) : 0;
    return { mean: m, sd: Math.sqrt(v), n };
  }

  function derived(toes) {
    const frontTotal = toes.FL + toes.FR;
    const thrust = (toes.RL + toes.RR) / 2;
    return {
      front_total_toe_deg: frontTotal,
      rear_total_toe_deg: toes.RL + toes.RR,
      thrust_angle_deg: thrust,
      front_toe_vs_thrust_deg: frontTotal - 2 * thrust,
    };
  }

  function degToMm(deg, trackMm) {
    return Math.tan(deg * DEG) * (trackMm || 1500) / 2;
  }

  function toCSV(rows, header) {
    const cols = header || Object.keys(rows[0] || {});
    const lines = [cols.join(',')];
    for (const r of rows) {
      lines.push(cols.map(c => {
        const v = r[c];
        if (v == null) return '';
        if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) {
          return '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(','));
    }
    return lines.join('\n');
  }

  const Estimator = {
    V, DEG, RAD, rotateAxis,
    principalAxis, integrate, integrateVecCumulative,
    camberStatic,
    estimateFromRollV2, straightGateV2,
    estimateFromRoll, straightGate, // 旧v1
    stats, derived, degToMm, toCSV,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Estimator;
  else global.Estimator = Estimator;
})(typeof window !== 'undefined' ? window : globalThis);
