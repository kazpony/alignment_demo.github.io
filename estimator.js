/* =====================================================================
 * estimator.js  —  静的計測の補助（キャンバー・ベクトル・統計・CSV）
 *   静的磁気モード用に最小限。トーは magnetics.js が担当。
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

  // 静止キャンバー: 端末Z(=ホイール面法線と治具で平行)の水平面からの傾き
  function camberStatic(accelStatic, wheelNormalSensor){
    const up=V.unit(accelStatic);
    const s=V.unit(wheelNormalSensor||[0,0,1]);
    return Math.asin(Math.max(-1,Math.min(1,V.dot(s,up))))*RAD;
  }
  function stats(arr){
    const n=arr.length; if(!n) return {mean:NaN,sd:NaN,n:0};
    const m=arr.reduce((a,b)=>a+b,0)/n;
    const v=n>1?arr.reduce((a,b)=>a+(b-m)**2,0)/(n-1):0;
    return {mean:m,sd:Math.sqrt(v),n};
  }
  function derived(toes){
    const frontTotal=toes.FL+toes.FR, thrust=(toes.RL+toes.RR)/2;
    return { front_total_toe_deg:frontTotal, rear_total_toe_deg:toes.RL+toes.RR,
             thrust_angle_deg:thrust, front_toe_vs_thrust_deg:frontTotal-2*thrust };
  }
  function degToMm(deg,trackMm){ return Math.tan(deg*DEG)*(trackMm||1500)/2; }
  function toCSV(rows,header){
    const cols=header||Object.keys(rows[0]||{});
    const lines=[cols.join(',')];
    for(const r of rows){ lines.push(cols.map(c=>{const v=r[c];
      if(v==null) return '';
      if(typeof v==='string'&&(v.includes(',')||v.includes('"'))) return '"'+v.replace(/"/g,'""')+'"';
      return v;}).join(',')); }
    return lines.join('\n');
  }
  const E={ V,RAD,DEG, camberStatic, stats, derived, degToMm, toCSV };
  if(typeof module!=='undefined'&&module.exports) module.exports=E;
  else global.Estimator=E;
})(typeof window!=='undefined'?window:globalThis);
