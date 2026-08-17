/* =====================================================================
 * sensors.js  —  センサ抽象レイヤ
 *   Generic Sensor API 優先 / DeviceMotion フォールバック。実効レート実測。
 *   磁気センサは使用しない（設計方針）。
 *   統一サンプル: { t_ms, accel:[m/s^2], lin:[m/s^2], gyro:[rad/s] }
 * ===================================================================== */
(function (global) {
  'use strict';
  const HZ = 100;
  function now() { return (performance && performance.now) ? performance.now() : Date.now(); }

  class SensorHub {
    constructor() {
      this.running = false; this.mode = null; this._cb = null; this._sensors = [];
      this._last = { accel: null, lin: null, gyro: null };
      this._count = 0; this._t0 = 0; this._gravityLP = [0, 0, 9.81]; this.effectiveHz = 0;
    }
    static async requestPermission() {
      try {
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
          return (await DeviceMotionEvent.requestPermission()) === 'granted';
        }
      } catch (e) {}
      return true;
    }
    async start(cb) {
      this._cb = cb; this._count = 0; this._t0 = now();
      const hasGeneric = ('Accelerometer' in global) && ('Gyroscope' in global);
      if (hasGeneric) {
        try { await this._startGeneric(); this.mode = 'generic'; this.running = true; this._startRateMeter(); return this.mode; }
        catch (e) { console.warn('Generic失敗→DeviceMotion', e); this._stopGeneric(); }
      }
      this._startDeviceMotion(); this.mode = 'devicemotion'; this.running = true; this._startRateMeter();
      return this.mode;
    }
    async _startGeneric() {
      const opts = { frequency: HZ };
      const accel = new global.Accelerometer(opts);
      const gyro = new global.Gyroscope(opts);
      let lin = null, grav = null;
      if ('LinearAccelerationSensor' in global) lin = new global.LinearAccelerationSensor(opts);
      if ('GravitySensor' in global) grav = new global.GravitySensor(opts);
      accel.addEventListener('reading', () => { this._last.accel = [accel.x, accel.y, accel.z]; this._emit(); });
      gyro.addEventListener('reading', () => { this._last.gyro = [gyro.x, gyro.y, gyro.z]; });
      if (lin) lin.addEventListener('reading', () => { this._last.lin = [lin.x, lin.y, lin.z]; });
      if (grav) grav.addEventListener('reading', () => { this._gravityLP = [grav.x, grav.y, grav.z]; });
      this._sensors = [accel, gyro, lin, grav].filter(Boolean);
      for (const s of this._sensors) {
        s.addEventListener('error', (ev) => console.warn('sensor error', ev.error && ev.error.name));
        s.start();
      }
    }
    _stopGeneric() { for (const s of this._sensors) { try { s.stop(); } catch (e) {} } this._sensors = []; }
    _startDeviceMotion() {
      this._dmHandler = (ev) => {
        const ig = ev.accelerationIncludingGravity, a = ev.acceleration, rr = ev.rotationRate;
        if (ig) this._last.accel = [ig.x || 0, ig.y || 0, ig.z || 0];
        if (a && a.x != null) this._last.lin = [a.x || 0, a.y || 0, a.z || 0];
        if (rr) { const d2r = Math.PI / 180; this._last.gyro = [(rr.beta||0)*d2r, (rr.gamma||0)*d2r, (rr.alpha||0)*d2r]; }
        this._emit();
      };
      global.addEventListener('devicemotion', this._dmHandler, true);
    }
    _emit() {
      if (!this._last.accel || !this._last.gyro) return;
      const alpha = 0.92, g = this._gravityLP, a = this._last.accel;
      this._gravityLP = [alpha*g[0]+(1-alpha)*a[0], alpha*g[1]+(1-alpha)*a[1], alpha*g[2]+(1-alpha)*a[2]];
      let lin = this._last.lin;
      if (!lin) lin = [a[0]-this._gravityLP[0], a[1]-this._gravityLP[1], a[2]-this._gravityLP[2]];
      this._count++;
      const sample = { t_ms: now(), accel: a.slice(), lin: lin.slice(), gyro: this._last.gyro.slice() };
      if (this._cb) this._cb(sample);
    }
    _startRateMeter() {
      this._rateTimer = setInterval(() => {
        const dt = (now() - this._t0) / 1000; this.effectiveHz = dt > 0 ? this._count / dt : 0;
      }, 500);
    }
    gravity() { return this._gravityLP.slice(); }
    stop() {
      this.running = false;
      if (this._rateTimer) clearInterval(this._rateTimer);
      if (this.mode === 'generic') this._stopGeneric();
      else if (this._dmHandler) global.removeEventListener('devicemotion', this._dmHandler, true);
      this._cb = null;
    }
  }
  const API = { SensorHub, HZ };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.Sensors = API;
})(typeof window !== 'undefined' ? window : globalThis);
