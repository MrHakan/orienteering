// Live sound and vibration for the game. The AudioContext is created on the
// first user gesture (browsers block autoplay); ambience follows the scene's
// weather and pauses with the tab. Muting stops everything, including haptics.

import { ambience, cue } from './soundscape.js';

export class LiveAudio {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.ctx = null; this.master = null; this.bed = null; this.weather = {};
    const unlock = () => { this.unlock(); };
    for (const type of ['pointerdown', 'keydown', 'touchstart']) addEventListener(type, unlock, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else if (this.enabled) this.ctx.resume();
    });
  }

  unlock() {
    if (!this.enabled || this.ctx || typeof AudioContext === 'undefined') return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(this.ctx.destination);
      this.restartAmbience();
    } catch { this.ctx = null; }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.bed?.stop(); this.bed = null; this.ctx?.suspend(); return; }
    if (this.ctx) { this.ctx.resume(); this.restartAmbience(); }
  }

  /** Weather as from weatherParams(): { wind: [e, n], precipitation, storm }. */
  setWeather(weather) {
    const key = JSON.stringify([weather.wind, weather.precipitation, weather.rain, weather.storm]);
    if (key === this.weatherKey) return;
    this.weatherKey = key; this.weather = weather;
    this.restartAmbience();
  }

  restartAmbience() {
    if (!this.ctx || !this.enabled) return;
    this.bed?.stop();
    this.bed = ambience(this.ctx, this.master, this.weather, { start: this.ctx.currentTime + 0.05, level: 0.8, seed: 'live' });
  }

  cue(kind, delay = 0) {
    if (this.ctx && this.enabled) cue(this.ctx, this.master, kind, this.ctx.currentTime + delay);
  }

  vibrate(pattern) {
    if (this.enabled && navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* unsupported */ } }
  }

  /** Answer feedback: a sniper shot first, then the verdict, with a matching buzz. */
  answer(right, { shot = false } = {}) {
    if (shot) this.cue('shot');
    this.cue(right ? 'correct' : 'wrong', shot ? 0.55 : 0);
    this.vibrate(right ? 35 : [70, 50, 70]);
  }
}
