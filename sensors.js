/* =====================================================================
 * sensors.js  —  センサ抽象レイヤ
 * ---------------------------------------------------------------------
 * Generic Sensor API を第一候補、DeviceMotion をフォールバックとして
 * 統一インタフェースで購読する。実効サンプルレートを実測。
 * 磁気センサは設計上使用しない（仕様書5.2）。
 *
 * 統一サンプル形式（コールバックに渡す）:
 *   { t_ms, accel:[ax,ay,az], lin:[lx,ly,lz], gyro:[gx,gy,gz] }
 *   - accel : 重力込み加速度 [m/s^2]（端末座標）
 *   - lin   : 重力除去済み加速度 [m/s^2]（無ければ accel-重力推定で近似）
 *   - gyro  : 角速度 [rad/s]
 * ===================================================================== */
(function (global) {
  'use strict';

  const HZ = 100; // 要求周波数

  function now() { return (performance && performance.now) ? performance.now() : Date.now(); }

  class SensorHub {
    constructor() {
      this.running = false;
      this.mode = null;              // 'generic' | 'devicemotion'
      this._cb = null;
      this._sensors = [];
      this._last = { accel: null, lin: null, gyro: null };
      this._count = 0;
      this._t0 = 0;
      this._gravityLP = [0, 0, 9.81]; // 重力ローパス推定（lin近似用）
      this.effectiveHz = 0;
    }

    /* 権限要求（iOS互換のため。Androidは通常不要だが安全に呼ぶ）*/
    static async requestPermission() {
      try {
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
          const r = await DeviceMotionEvent.requestPermission();
          return r === 'granted';
        }
      } catch (e) { /* noop */ }
      return true; // Androidは既定で許可扱い
    }

    async start(cb) {
      this._cb = cb;
      this._count = 0;
      this._t0 = now();
      // Generic Sensor API が使えるか
      const hasGeneric = ('Accelerometer' in global) && ('Gyroscope' in global);
      if (hasGeneric) {
        try {
          await this._startGeneric();
          this.mode = 'generic';
          this.running = true;
          this._startRateMeter();
          return this.mode;
        } catch (e) {
          console.warn('Generic Sensor 起動失敗, DeviceMotionへ:', e);
          this._stopGeneric();
        }
      }
      this._startDeviceMotion();
      this.mode = 'devicemotion';
      this.running = true;
      this._startRateMeter();
      return this.mode;
    }

    async _startGeneric() {
      const opts = { frequency: HZ };
      const accel = new global.Accelerometer(opts);
      const gyro = new global.Gyroscope(opts);
      let lin = null, grav = null;
      if ('LinearAccelerationSensor' in global) lin = new global.LinearAccelerationSensor(opts);
      if ('GravitySensor' in global) grav = new global.GravitySensor(opts);

      accel.addEventListener('reading', () => {
        this._last.accel = [accel.x, accel.y, accel.z];
        this._emit();
      });
      gyro.addEventListener('reading', () => {
        this._last.gyro = [gyro.x, gyro.y, gyro.z];
      });
      if (lin) lin.addEventListener('reading', () => {
        this._last.lin = [lin.x, lin.y, lin.z];
      });
      if (grav) grav.addEventListener('reading', () => {
        this._gravityLP = [grav.x, grav.y, grav.z];
      });

      this._sensors = [accel, gyro, lin, grav].filter(Boolean);
      // 一部端末は onerror でしか失敗が分からない
      for (const s of this._sensors) {
        s.addEventListener('error', (ev) => console.warn('sensor error', ev.error && ev.error.name));
        s.start();
      }
    }

    _stopGeneric() {
      for (const s of this._sensors) { try { s.stop(); } catch (e) {} }
      this._sensors = [];
    }

    _startDeviceMotion() {
      this._dmHandler = (ev) => {
        const ig = ev.accelerationIncludingGravity;
        const a = ev.acceleration;
        const rr = ev.rotationRate;
        if (ig) this._last.accel = [ig.x || 0, ig.y || 0, ig.z || 0];
        if (a && (a.x != null)) this._last.lin = [a.x || 0, a.y || 0, a.z || 0];
        if (rr) {
          // deg/s -> rad/s
          const d2r = Math.PI / 180;
          this._last.gyro = [(rr.beta||0)*d2r, (rr.gamma||0)*d2r, (rr.alpha||0)*d2r];
        }
        this._emit();
      };
      global.addEventListener('devicemotion', this._dmHandler, true);
    }

    _emit() {
      if (!this._last.accel || !this._last.gyro) return;
      // 重力ローパス更新（linが無い端末の近似用）
      const alpha = 0.92;
      const g = this._gravityLP, a = this._last.accel;
      this._gravityLP = [
        alpha * g[0] + (1 - alpha) * a[0],
        alpha * g[1] + (1 - alpha) * a[1],
        alpha * g[2] + (1 - alpha) * a[2],
      ];
      let lin = this._last.lin;
      if (!lin) {
        lin = [a[0] - this._gravityLP[0], a[1] - this._gravityLP[1], a[2] - this._gravityLP[2]];
      }
      this._count++;
      const sample = {
        t_ms: now(),
        accel: a.slice(),
        lin: lin.slice(),
        gyro: this._last.gyro.slice(),
      };
      if (this._cb) this._cb(sample);
    }

    _startRateMeter() {
      this._rateTimer = setInterval(() => {
        const dt = (now() - this._t0) / 1000;
        this.effectiveHz = dt > 0 ? this._count / dt : 0;
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
