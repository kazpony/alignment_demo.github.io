/* sensors.js — センサ抽象（磁気対応）。Generic Sensor優先 / DeviceMotionフォールバック。
   統一サンプル: { t_ms, accel:[m/s^2], gyro:[rad/s], mag:[uT]|null } */
(function (global) {
  'use strict';
  const HZ = 50;
  function now(){ return (performance&&performance.now)?performance.now():Date.now(); }
  class SensorHub {
    constructor(){ this.running=false; this.mode=null; this._cb=null; this._sensors=[];
      this._last={accel:null,gyro:[0,0,0],mag:null}; this._count=0; this._t0=0;
      this._gravityLP=[0,0,9.81]; this.effectiveHz=0; this.hasMag=false; }
    static async requestPermission(){
      let ok=true;
      try{
        if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function') ok=(await DeviceMotionEvent.requestPermission())==='granted';
        if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function') await DeviceOrientationEvent.requestPermission();
      }catch(e){}
      return ok;
    }
    async start(cb){
      this._cb=cb; this._count=0; this._t0=now();
      const hasGeneric=('Accelerometer' in global)&&('Gyroscope' in global);
      if(hasGeneric){ try{ await this._startGeneric(); this.mode='generic'; this.running=true; this._rate(); return this.mode; }
        catch(e){ console.warn('Generic失敗→DeviceMotion',e); this._stopGeneric(); } }
      this._startDeviceMotion(); this.mode='devicemotion'; this.running=true; this._rate(); return this.mode;
    }
    async _startGeneric(){
      const opts={frequency:HZ};
      const accel=new global.Accelerometer(opts), gyro=new global.Gyroscope(opts);
      accel.addEventListener('reading',()=>{ this._last.accel=[accel.x,accel.y,accel.z]; this._emit(); });
      gyro.addEventListener('reading',()=>{ this._last.gyro=[gyro.x,gyro.y,gyro.z]; });
      this._sensors=[accel,gyro];
      if('Magnetometer' in global){
        try{ const mag=new global.Magnetometer(opts);
          mag.addEventListener('reading',()=>{ this._last.mag=[mag.x,mag.y,mag.z]; });
          mag.addEventListener('error',e=>console.warn('mag',e.error&&e.error.name));
          mag.start(); this._sensors.push(mag); this.hasMag=true;
        }catch(e){ console.warn('Magnetometer利用不可',e); }
      }
      for(const s of [accel,gyro]){ s.addEventListener('error',ev=>console.warn('sensor error',ev.error&&ev.error.name)); s.start(); }
    }
    _stopGeneric(){ for(const s of this._sensors){ try{s.stop();}catch(e){} } this._sensors=[]; }
    _startDeviceMotion(){
      this._dm=(ev)=>{ const ig=ev.accelerationIncludingGravity, rr=ev.rotationRate;
        if(ig) this._last.accel=[ig.x||0,ig.y||0,ig.z||0];
        if(rr){ const d2r=Math.PI/180; this._last.gyro=[(rr.beta||0)*d2r,(rr.gamma||0)*d2r,(rr.alpha||0)*d2r]; }
        this._emit(); };
      global.addEventListener('devicemotion',this._dm,true); this.hasMag=false;
    }
    _emit(){
      if(!this._last.accel) return;
      const a=this._last.accel, al=0.92, g=this._gravityLP;
      this._gravityLP=[al*g[0]+(1-al)*a[0],al*g[1]+(1-al)*a[1],al*g[2]+(1-al)*a[2]];
      this._count++;
      const sample={ t_ms:now(), accel:a.slice(), gyro:(this._last.gyro||[0,0,0]).slice(), mag:this._last.mag?this._last.mag.slice():null };
      if(this._cb) this._cb(sample);
    }
    _rate(){ this._rt=setInterval(()=>{ const dt=(now()-this._t0)/1000; this.effectiveHz=dt>0?this._count/dt:0; },500); }
    gravity(){ return this._gravityLP.slice(); }
    stop(){ this.running=false; if(this._rt) clearInterval(this._rt);
      if(this.mode==='generic') this._stopGeneric(); else if(this._dm) global.removeEventListener('devicemotion',this._dm,true); this._cb=null; }
  }
  const API={SensorHub,HZ};
  if(typeof module!=='undefined'&&module.exports) module.exports=API; else global.Sensors=API;
})(typeof window!=='undefined'?window:globalThis);
