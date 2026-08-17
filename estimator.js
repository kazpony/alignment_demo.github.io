/* =====================================================================
 * estimator.js  —  並進基準法アライメント計測の信号処理コア
 * ---------------------------------------------------------------------
 * 依存なし（ブラウザ / Node 双方で動く純粋関数群）。
 * 数式は仕様書 3.3 / toe_sim.py Part A と完全一致。
 *
 * 座標系（センサ=端末座標）:
 *   up  = 重力の逆向き（鉛直上）
 *   f   = 水平化した車体前方（並進方向）
 *   r   = ホイール進行方位（水平化, r = s × up）
 *   toe = atan2( dot(cross(f,r),up), dot(f,r) )
 *   cam = asin( dot(s, up) )
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

  // ---- 対称3x3行列の最大固有ベクトル（べき乗法; PCA主軸抽出用）----
  function principalAxis(vectors) {
    // 共分散行列（平均差し引き）
    const mu = V.mean(vectors);
    let cxx=0, cxy=0, cxz=0, cyy=0, cyz=0, czz=0;
    for (const v of vectors) {
      const d0=v[0]-mu[0], d1=v[1]-mu[1], d2=v[2]-mu[2];
      cxx+=d0*d0; cxy+=d0*d1; cxz+=d0*d2;
      cyy+=d1*d1; cyz+=d1*d2; czz+=d2*d2;
    }
    const C = [[cxx,cxy,cxz],[cxy,cyy,cyz],[cxz,cyz,czz]];
    // べき乗反復
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

  // ---- 台形積分 -------------------------------------------------
  function integrate(values, times_ms) {
    let acc = 0;
    for (let i = 1; i < values.length; i++) {
      const dt = (times_ms[i] - times_ms[i-1]) / 1000;
      acc += 0.5 * (values[i] + values[i-1]) * dt;
    }
    return acc;
  }

  /* -----------------------------------------------------------------
   * キャンバー（静止・治具仮定）
   *   端末Z軸(=画面法線=ホイール面法線と治具で平行) の水平面からの傾き。
   *   accelStatic: 静止時の加速度(重力込み, 端末座標) 平均 [m/s^2]
   *   ラベル: 正 = Z軸が上向きに傾く側（符号は運用で規定）
   * --------------------------------------------------------------- */
  function camberStatic(accelStatic, wheelNormalSensor) {
    // up = 重力の逆 = 静止加速度方向（反力）
    const up = V.unit(accelStatic);
    // ホイール法線（既定は端末Z軸 = [0,0,1]）
    const s = V.unit(wheelNormalSensor || [0, 0, 1]);
    const camber = Math.asin(Math.max(-1, Math.min(1, V.dot(s, up)))) * RAD;
    return camber;
  }

  /* -----------------------------------------------------------------
   * 転がし1回からトー/キャンバーを算出（TRIAD, 治具誤差非依存）
   *   samples: { gyro:[gx,gy,gz](rad/s), lin:[lx,ly,lz](m/s^2), t_ms } の配列
   *   accelStatic: 静止加速度平均（up算出用）
   *   gyroBias: 静止ジャイロバイアス [rad/s]
   *   戻り: { toe_deg, camber_deg, dyaw_deg, spinRate, transStrength }
   * --------------------------------------------------------------- */
  function estimateFromRoll(samples, accelStatic, gyroBias) {
    const up = V.unit(accelStatic);
    const bias = gyroBias || [0, 0, 0];

    // バイアス除去ジャイロ列
    const gyros = samples.map(s => V.sub(s.gyro, bias));
    const lins  = samples.map(s => s.lin);
    const times = samples.map(s => s.t_ms);

    // スピン軸 s = 平均角速度方向（回転が支配的なので方向が定まる）
    const gmean = V.mean(gyros);
    const s = V.unit(gmean);
    const spinRate = V.norm(gmean); // rad/s（目安）

    // 並進方向 t = 線形加速度の主軸（PCA, 押し全体）
    let t = principalAxis(lins);
    const half = Math.max(1, Math.floor(lins.length / 2));
    const front = V.mean(lins.slice(0, half));
    if (V.dot(front, t) < 0) t = V.scale(t, -1);
    const transStrength = V.norm(front); // 押しの強さ目安 [m/s^2]

    // --- 直進ゲート判定量: 水平面内での線形加速度の「2次元的広がり」---
    //   押しは加速→減速で ±t 方向に振れる（1次元/rank-1）。
    //   ・直進 / 定常クラブ（真っ直ぐだが角度付き平行移動）: 全て1本の軸上
    //       → 直交方向の広がり≈0 → curve≈0° → ゲート通過
    //       （床オフセットは検出不能=誤差の下限, 仕様書4.3と整合）
    //   ・曲がる押し（途中で方位が折れる）: 方向が2次元に散る
    //       → 直交方向の広がり大 → curve大 → 棄却
    //   スピン軸のcamberリーク問題を受けず、方向の正味/対称に依らず頑健。
    // 水平基底 (e1=前方f, e2=横)
    const e1 = V.unit(V.sub(t, V.scale(up, V.dot(t, up))));
    const e2 = V.unit(V.cross(up, e1));
    let saa = 0, sab = 0, sbb = 0, ma = 0, mb = 0;
    for (const l of lins) { const a = V.dot(l, e1), b = V.dot(l, e2); ma += a; mb += b; }
    ma /= lins.length; mb /= lins.length;
    for (const l of lins) {
      const a = V.dot(l, e1) - ma, b = V.dot(l, e2) - mb;
      saa += a * a; sab += a * b; sbb += b * b;
    }
    const n = lins.length;
    saa /= n; sab /= n; sbb /= n;
    // 2x2共分散の固有値（閉形式）
    const tr = saa + sbb, det = saa * sbb - sab * sab;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const lMax = tr / 2 + disc, lMin = Math.max(0, tr / 2 - disc);
    // 広がり角: 主軸に対する直交成分の実効角
    const dyaw_deg = Math.atan2(Math.sqrt(lMin), Math.sqrt(lMax)) * RAD;

    // TRIAD
    const f = V.unit(V.sub(t, V.scale(up, V.dot(t, up))));   // 前（水平化）
    const r = V.unit(V.cross(s, up));                        // ホイール方位

    const toe = Math.atan2(V.dot(V.cross(f, r), up), V.dot(f, r)) * RAD;
    const camber = Math.asin(Math.max(-1, Math.min(1, V.dot(s, up)))) * RAD;

    return {
      toe_deg: toe,
      camber_deg: camber,
      dyaw_deg: dyaw_deg,
      spinRate: spinRate,
      transStrength: transStrength,
    };
  }

  /* -----------------------------------------------------------------
   * 直進ゲート判定
   *   dyaw_deg: 押し中ヨー総変化 [deg]
   *   transStrength: 並進の強さ [m/s^2]
   *   cfg: { yawThreshDeg, minTransAccel }
   * --------------------------------------------------------------- */
  function straightGate(res, cfg) {
    const yawOk = Math.abs(res.dyaw_deg) <= cfg.yawThreshDeg;
    const snrOk = res.transStrength >= cfg.minTransAccel;
    let reason = 'ok';
    if (!snrOk) reason = 'weak';       // 押しが弱い
    else if (!yawOk) reason = 'curved'; // 曲がった
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

  /* -----------------------------------------------------------------
   * 派生量（4輪トーから）
   *   toes: { FL, FR, RL, RR } [deg]
   *   符号定義は相対比較用に一貫していれば可（仕様書 3.4）
   * --------------------------------------------------------------- */
  function derived(toes) {
    const frontTotal = toes.FL + toes.FR;
    const thrust = (toes.RL + toes.RR) / 2;
    const frontVsThrust = frontTotal - 2 * thrust;
    return {
      front_total_toe_deg: frontTotal,
      rear_total_toe_deg: toes.RL + toes.RR,
      thrust_angle_deg: thrust,
      front_toe_vs_thrust_deg: frontVsThrust,
    };
  }

  // ---- 角度→トー量[mm]換算（参考表示用）------------------------
  function degToMm(deg, trackMm) {
    return Math.tan(deg * DEG) * (trackMm || 1500) / 2;
  }

  // ---- CSV生成 -------------------------------------------------
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
    V, DEG, RAD,
    principalAxis, integrate,
    camberStatic, estimateFromRoll, straightGate,
    stats, derived, degToMm, toCSV,
  };

  // UMD風エクスポート
  if (typeof module !== 'undefined' && module.exports) module.exports = Estimator;
  else global.Estimator = Estimator;
})(typeof window !== 'undefined' ? window : globalThis);
