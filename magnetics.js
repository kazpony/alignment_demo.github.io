/* =====================================================================
 * magnetics.js  —  静的・磁気ベース アライメント計測コア
 * ---------------------------------------------------------------------
 * 依存なし（ブラウザ / Node 双方）。
 *
 * 機能:
 *   1) hardIronFit         : 8の字校正（球フィットで端末ハードアイアン除去）
 *   2) slideSeparate       : 3点スライドで「ホイール局所鉄」と「地磁気」を分離
 *                            （鉄源までの基準距離 r_b は未知として非線形探索）
 *   3) magneticHeading     : 地磁気(端末座標)＋重力から水平方位を算出
 *   4) toeFromHeadings     : 車両ゼロ基準との差でトーを算出
 *
 * 座標系: 端末(スマホ)座標。up=重力の逆。
 * 磁気ベクトルは端末座標で観測される [uT]。
 * ===================================================================== */
(function (global) {
  'use strict';

  const V = {
    add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],
    sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
    scale:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
    cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
    norm:(a)=>Math.hypot(a[0],a[1],a[2]),
    unit:(a)=>{const n=Math.hypot(a[0],a[1],a[2]);return n>1e-12?[a[0]/n,a[1]/n,a[2]/n]:[0,0,0];},
    mean:(arr)=>{const s=[0,0,0];for(const v of arr){s[0]+=v[0];s[1]+=v[1];s[2]+=v[2];}const n=arr.length||1;return[s[0]/n,s[1]/n,s[2]/n];},
  };
  const RAD=180/Math.PI, DEG=Math.PI/180;

  // --- 小さな線形ソルバ（正規方程式, n<=6）---
  function solveLS(A, b) {
    // A: m x n, b: m. return x (n) via normal equations (A^T A) x = A^T b
    const m=A.length, n=A[0].length;
    const AtA=Array.from({length:n},()=>new Array(n).fill(0));
    const Atb=new Array(n).fill(0);
    for(let i=0;i<m;i++){
      for(let j=0;j<n;j++){
        Atb[j]+=A[i][j]*b[i];
        for(let k=0;k<n;k++) AtA[j][k]+=A[i][j]*A[i][k];
      }
    }
    return gauss(AtA, Atb);
  }
  function gauss(M, y) {
    const n=y.length;
    const A=M.map((r,i)=>r.concat([y[i]]));
    for(let c=0;c<n;c++){
      let p=c; for(let r=c+1;r<n;r++) if(Math.abs(A[r][c])>Math.abs(A[p][c])) p=r;
      [A[c],A[p]]=[A[p],A[c]];
      const piv=A[c][c]||1e-12;
      for(let k=c;k<=n;k++) A[c][k]/=piv;
      for(let r=0;r<n;r++){ if(r===c) continue; const f=A[r][c];
        for(let k=c;k<=n;k++) A[r][k]-=f*A[c][k]; }
    }
    return A.map(r=>r[n]);
  }

  /* -----------------------------------------------------------------
   * 1) ハードアイアン校正（8の字）: 球フィット
   *   |m - h|^2 = R^2  →  |m|^2 = 2 m·h + (R^2-|h|^2)
   *   params=[hx,hy,hz,c], row=[2mx,2my,2mz,1], b=|m|^2
   *   戻り: { offset:[hx,hy,hz], radius, residualPct, coverage }
   * --------------------------------------------------------------- */
  function hardIronFit(samples) {
    if (samples.length < 20) return null;
    const A=[], b=[];
    for(const m of samples){
      A.push([2*m[0],2*m[1],2*m[2],1]);
      b.push(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);
    }
    const p=solveLS(A,b);
    const h=[p[0],p[1],p[2]];
    const R=Math.sqrt(Math.max(0,p[3]+h[0]*h[0]+h[1]*h[1]+h[2]*h[2]));
    // 残差（校正後 |m-h| が R にどれだけ揃うか）
    let ss=0;
    for(const m of samples){ const d=V.norm(V.sub(m,h))-R; ss+=d*d; }
    const rms=Math.sqrt(ss/samples.length);
    const residualPct = R>0 ? 100*rms/R : 999;
    // カバレッジ: 校正後ベクトルの方向分布（球面をどれだけ舐めたか）
    const dirs=samples.map(m=>V.unit(V.sub(m,h)));
    const cov=coverageScore(dirs);
    return { offset:h, radius:R, residualPct, coverage:cov, n:samples.length };
  }
  function applyHardIron(m, cal){ return cal ? V.sub(m, cal.offset) : m; }

  // 方向カバレッジ（0..1）: 単位球上サンプルの分散共分散が等方に近いほど1
  function coverageScore(dirs){
    if(dirs.length<6) return 0;
    let c=[[0,0,0],[0,0,0],[0,0,0]];
    for(const d of dirs) for(let i=0;i<3;i++) for(let j=0;j<3;j++) c[i][j]+=d[i]*d[j];
    const n=dirs.length; for(let i=0;i<3;i++) for(let j=0;j<3;j++) c[i][j]/=n;
    // 固有値の最小/最大比の代理: トレース基準の等方性
    const tr=c[0][0]+c[1][1]+c[2][2];
    // 最小固有値をべき乗法(逆)で近似せず、対角優位近似
    const diag=[c[0][0],c[1][1],c[2][2]].sort((a,b)=>a-b);
    return Math.max(0, Math.min(1, diag[0]/(tr/3)));
  }

  /* -----------------------------------------------------------------
   * 2) 3点スライド分離
   *   各スライド位置(オフセット s_i[cm], ホイールから遠ざかる向き)で
   *   校正後の磁気ベクトル m_i を静止平均で取得。
   *   モデル: m_i = E + A * (r_b/(r_b+s_i))^p
   *     E : 地磁気(端末座標, 未知3)   … 欲しい量
   *     A : 局所鉄の基準ベクトル(未知3)
   *     r_b: 鉄源までの基準距離(未知, 非線形探索)
   *     p : 減衰指数(既定3=双極子)
   *   戻り: { E, A, r_b_cm, residual, ok }
   * --------------------------------------------------------------- */
  function slideSeparate(reads, offsets_cm, opts) {
    opts = opts || {};
    const p = opts.exponent || 3;
    const n = reads.length;
    if (n < 3 || offsets_cm.length !== n) return { ok:false };

    // r_b を対数グリッド＋局所細分で探索し、各 r_b で (E,A) を線形LS
    function fitGivenRb(rb) {
      // k_i = (rb/(rb+s_i))^p  （s_0 の位置で基準化されるよう rb 自体に含める）
      const A=[], bx=[], by=[], bz=[];
      const ks=[];
      for(let i=0;i<n;i++){
        const k=Math.pow(rb/(rb+offsets_cm[i]), p);
        ks.push(k);
        // 未知 [Ex,Ey,Ez,Ax,Ay,Az] を軸ごとに解くため、成分別に構築
      }
      // 成分ごとに: m_i = E_c + A_c * k_i  → 2未知の直線回帰×3
      const E=[0,0,0], Avec=[0,0,0]; let res=0;
      for(let c=0;c<3;c++){
        // 直線回帰 y=E_c + A_c*k
        let Sk=0,Skk=0,Sy=0,Sky=0;
        for(let i=0;i<n;i++){ const k=ks[i], y=reads[i][c]; Sk+=k;Skk+=k*k;Sy+=y;Sky+=k*y; }
        const det=n*Skk-Sk*Sk;
        let Ec,Ac;
        if(Math.abs(det)<1e-9){ Ec=Sy/n; Ac=0; }
        else { Ac=(n*Sky-Sk*Sy)/det; Ec=(Sy-Ac*Sk)/n; }
        E[c]=Ec; Avec[c]=Ac;
        for(let i=0;i<n;i++){ const pred=Ec+Ac*ks[i]; const d=reads[i][c]-pred; res+=d*d; }
      }
      return { E, A:Avec, res };
    }

    let best=null;
    // 探索範囲 rb: 1〜60cm
    for(let rb=1; rb<=60; rb+=0.5){
      const f=fitGivenRb(rb);
      if(!best || f.res<best.res){ best={...f, rb}; }
    }
    // 局所細分
    for(let rb=Math.max(1,best.rb-0.5); rb<=best.rb+0.5; rb+=0.05){
      const f=fitGivenRb(rb);
      if(f.res<best.res){ best={...f, rb}; }
    }
    const residual=Math.sqrt(best.res/(n*3));
    return { ok:true, E:best.E, A:best.A, r_b_cm:best.rb, residual, exponent:p };
  }

  /* -----------------------------------------------------------------
   * 3) 磁気ヘディング（水平方位）
   *   E: 地磁気(端末座標), up: 重力の逆(端末座標),
   *   dirAxis: 方位を測りたい端末座標の基準軸（水平化して使用）
   *   戻り: dirAxis の「磁北からの方位角」[deg]（CCW+）
   * --------------------------------------------------------------- */
  function magneticHeading(E, up, dirAxis) {
    const u = V.unit(up);
    const north = V.unit(V.sub(E, V.scale(u, V.dot(E, u))));   // 磁北(水平)
    const d = V.unit(V.sub(dirAxis, V.scale(u, V.dot(dirAxis, u))));
    // north→d の符号付き水平角
    return Math.atan2(V.dot(V.cross(north, d), u), V.dot(north, d)) * RAD;
  }

  /* -----------------------------------------------------------------
   * 4) トー = 輪方位 − 車両基準方位（同じ磁北基準なので差で絶対トー）
   * --------------------------------------------------------------- */
  function toeFromHeadings(wheelAz_deg, vehicleAz_deg) {
    let d = wheelAz_deg - vehicleAz_deg;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    return d;
  }

  function stats(arr){
    const n=arr.length; if(!n) return {mean:NaN,sd:NaN,n:0};
    const m=arr.reduce((a,b)=>a+b,0)/n;
    const v=n>1?arr.reduce((a,b)=>a+(b-m)**2,0)/(n-1):0;
    return {mean:m,sd:Math.sqrt(v),n};
  }

  const Magnetics = {
    V, RAD, DEG,
    hardIronFit, applyHardIron, coverageScore,
    slideSeparate, magneticHeading, toeFromHeadings, stats,
    _solveLS: solveLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Magnetics;
  else global.Magnetics = Magnetics;
})(typeof window !== 'undefined' ? window : globalThis);
