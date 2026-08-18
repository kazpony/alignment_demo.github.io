/* magnetics.js — 静的磁気コア（hardIron任意対応） */
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

  function solveLS(A,b){const m=A.length,n=A[0].length;
    const AtA=Array.from({length:n},()=>new Array(n).fill(0)),Atb=new Array(n).fill(0);
    for(let i=0;i<m;i++)for(let j=0;j<n;j++){Atb[j]+=A[i][j]*b[i];for(let k=0;k<n;k++)AtA[j][k]+=A[i][j]*A[i][k];}
    return gauss(AtA,Atb);}
  function gauss(M,y){const n=y.length,A=M.map((r,i)=>r.concat([y[i]]));
    for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(A[r][c])>Math.abs(A[p][c]))p=r;[A[c],A[p]]=[A[p],A[c]];
      const piv=A[c][c]||1e-12;for(let k=c;k<=n;k++)A[c][k]/=piv;
      for(let r=0;r<n;r++){if(r===c)continue;const f=A[r][c];for(let k=c;k<=n;k++)A[r][k]-=f*A[c][k];}}
    return A.map(r=>r[n]);}

  function hardIronFit(samples){
    if(samples.length<20) return null;
    const A=[],b=[];
    for(const m of samples){A.push([2*m[0],2*m[1],2*m[2],1]);b.push(m[0]*m[0]+m[1]*m[1]+m[2]*m[2]);}
    const p=solveLS(A,b),h=[p[0],p[1],p[2]];
    const R=Math.sqrt(Math.max(0,p[3]+h[0]*h[0]+h[1]*h[1]+h[2]*h[2]));
    let ss=0;for(const m of samples){const d=V.norm(V.sub(m,h))-R;ss+=d*d;}
    const rms=Math.sqrt(ss/samples.length),residualPct=R>0?100*rms/R:999;
    const dirs=samples.map(m=>V.unit(V.sub(m,h)));
    return {offset:h,radius:R,residualPct,coverage:coverageScore(dirs),n:samples.length};
  }
  function applyHardIron(m,cal){ return cal?V.sub(m,cal.offset):m; }
  function coverageScore(dirs){
    if(dirs.length<6) return 0;
    let c=[[0,0,0],[0,0,0],[0,0,0]];
    for(const d of dirs)for(let i=0;i<3;i++)for(let j=0;j<3;j++)c[i][j]+=d[i]*d[j];
    const n=dirs.length;for(let i=0;i<3;i++)for(let j=0;j<3;j++)c[i][j]/=n;
    const tr=c[0][0]+c[1][1]+c[2][2];
    const diag=[c[0][0],c[1][1],c[2][2]].sort((a,b)=>a-b);
    return Math.max(0,Math.min(1,diag[0]/(tr/3)));
  }

  function slideSeparate(reads,offsets_cm,opts){
    opts=opts||{};const p=opts.exponent||3,n=reads.length;
    if(n<3||offsets_cm.length!==n) return {ok:false};
    function fit(rb){
      const ks=offsets_cm.map(s=>Math.pow(rb/(rb+s),p));
      const E=[0,0,0],Av=[0,0,0];let res=0;
      for(let c=0;c<3;c++){let Sk=0,Skk=0,Sy=0,Sky=0;
        for(let i=0;i<n;i++){const k=ks[i],y=reads[i][c];Sk+=k;Skk+=k*k;Sy+=y;Sky+=k*y;}
        const det=n*Skk-Sk*Sk;let Ec,Ac;
        if(Math.abs(det)<1e-9){Ec=Sy/n;Ac=0;}else{Ac=(n*Sky-Sk*Sy)/det;Ec=(Sy-Ac*Sk)/n;}
        E[c]=Ec;Av[c]=Ac;for(let i=0;i<n;i++){const pr=Ec+Ac*ks[i],d=reads[i][c]-pr;res+=d*d;}}
      return {E,A:Av,res};
    }
    let best=null;
    for(let rb=1;rb<=60;rb+=0.5){const f=fit(rb);if(!best||f.res<best.res)best={...f,rb};}
    for(let rb=Math.max(1,best.rb-0.5);rb<=best.rb+0.5;rb+=0.05){const f=fit(rb);if(f.res<best.res)best={...f,rb};}
    return {ok:true,E:best.E,A:best.A,r_b_cm:best.rb,residual:Math.sqrt(best.res/(n*3)),exponent:p};
  }

  function magneticHeading(E,up,dirAxis){
    const u=V.unit(up);
    const north=V.unit(V.sub(E,V.scale(u,V.dot(E,u))));
    const d=V.unit(V.sub(dirAxis,V.scale(u,V.dot(dirAxis,u))));
    return Math.atan2(V.dot(V.cross(north,d),u),V.dot(north,d))*RAD;
  }
  function toeFromHeadings(w,v){let d=w-v;while(d>180)d-=360;while(d<-180)d+=360;return d;}
  function stats(arr){const n=arr.length;if(!n)return{mean:NaN,sd:NaN,n:0};
    const m=arr.reduce((a,b)=>a+b,0)/n,v=n>1?arr.reduce((a,b)=>a+(b-m)**2,0)/(n-1):0;
    return{mean:m,sd:Math.sqrt(v),n};}

  const Magnetics={V,RAD,DEG,hardIronFit,applyHardIron,coverageScore,slideSeparate,magneticHeading,toeFromHeadings,stats,_solveLS:solveLS};
  if(typeof module!=='undefined'&&module.exports) module.exports=Magnetics;
  else global.Magnetics=Magnetics;
})(typeof window!=='undefined'?window:globalThis);
