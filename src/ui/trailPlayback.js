// One live clock; the engine/export sampler remains independent of wall time.
import { clamp } from '../engine/grid.js';

export class TrailPlayback {
  constructor({ draw, onState = () => {}, duration = 12, now = () => performance.now(),
    request = (fn) => requestAnimationFrame(fn), cancel = (id) => cancelAnimationFrame(id) }) {
    Object.assign(this, { draw, onState, duration, now, request, cancel });
    this.time = 0; this.playing = false; this.raf = 0; this.last = null; this.inspectAt = null;
  }
  emit() { this.onState({ time: this.time, playing: this.playing, duration: this.duration }); }
  schedule() { if (!this.raf) this.raf = this.request((t) => this.tick(t)); }
  tick(timestamp) {
    this.raf = 0;
    if (this.playing && this.last !== null) this.time = clamp(this.time + Math.max(0, timestamp - this.last) / 1000, 0, this.duration);
    this.last = timestamp;
    let inspectElapsed = this.inspectAt === null ? undefined : (timestamp - this.inspectAt) / 1000;
    if (inspectElapsed > 2.8) { this.inspectAt = null; inspectElapsed = undefined; }
    if (this.time >= this.duration) this.playing = false;
    this.draw(this.time, { inspectElapsed }); this.emit();
    if (this.playing || this.inspectAt !== null) this.schedule();
  }
  refresh() {
    const inspectElapsed = this.inspectAt === null ? undefined : (this.now() - this.inspectAt) / 1000;
    this.draw(this.time, { inspectElapsed }); this.emit();
  }
  play() {
    if (this.time >= this.duration) this.time = 0;
    this.playing = true; this.last = this.now(); this.emit(); this.schedule();
  }
  pause() {
    if (this.playing && this.last !== null) this.time = clamp(this.time + Math.max(0, this.now() - this.last) / 1000, 0, this.duration);
    this.playing = false; this.last = null;
    if (this.raf && this.inspectAt === null) { this.cancel(this.raf); this.raf = 0; }
    this.refresh();
  }
  seek(seconds) { this.pause(); this.time = clamp(Number.isFinite(seconds) ? seconds : 0, 0, this.duration); this.refresh(); }
  replay() { this.time = 0; this.play(); }
  inspect() { this.inspectAt = this.now(); this.schedule(); }
  reset(duration = 12) {
    if (this.raf) this.cancel(this.raf);
    this.raf = 0; this.playing = false; this.last = null; this.inspectAt = null; this.time = 0; this.duration = duration; this.emit();
  }
}
