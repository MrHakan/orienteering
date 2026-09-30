import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { KNIVES, normaliseAppearance, knifeClipTime, knifeOverlayRect } from '../src/render/knifeClips.js';
import { TrailPlayback } from '../src/ui/trailPlayback.js';

test('every offered knife has a real local clip; unsupported old cosmetics use Classic', async () => {
  assert.deepEqual(KNIVES.map(k => k.id), ['classic', 'default', 'butterfly']);
  for (const clip of KNIVES) {
    const file = new URL('../src/assets/knives/' + clip.file, import.meta.url);
    assert.ok((await stat(file)).size > 100000);
  }
  assert.deepEqual(normaliseAppearance({knife:'karambit',character:'tactical',finish:'tiger',scale:9}),
    {knife:'classic',handedness:'right',scale:1});
});

test('clip sampling stays on source frames and replays actual inspection with one clock', () => {
  for (const clip of KNIVES) for (const t of [-1,0,1.2,2.3,4,6,7.4,8.5,10.2,12,100]) {
    const settings = {knife:clip.id}, frame = knifeClipTime(t, {}, settings);
    assert.equal(frame, knifeClipTime(t, {}, settings));
    assert.ok(frame >= 0 && frame < clip.duration);
    assert.ok(Math.abs(frame * clip.fps - Math.round(frame * clip.fps)) < 1e-5);
    assert.equal(knifeClipTime(6, {inspectElapsed:.6}, settings), knifeClipTime(1.8, {}, settings));
    const idle = knifeClipTime(6, {inspectElapsed:3}, settings);
    assert.ok(idle >= clip.idle[0] - 1 / clip.fps && idle <= clip.idle[1]);
  }
});

test('overlay preserves footage aspect and mirrors without changing clip time', () => {
  for (const clip of KNIVES) for (const aspect of [1.6,2]) for (const scale of [.8,1,1.15]) {
    const settings = {knife:clip.id,scale}, r = knifeOverlayRect(640,640/aspect,0,{},settings);
    assert.ok(Math.abs(r.w / r.h - clip.aspect) < 1e-6);
    assert.equal(r.y + r.h, 640/aspect);
    const left = {...settings,handedness:'left'};
    assert.deepEqual(knifeOverlayRect(640,640/aspect,0,{},left), {...r,mirror:true});
    assert.equal(knifeClipTime(2,{},settings),knifeClipTime(2,{},left));
  }
});

test('playback pause, seek, inspect and replay use one clock without camera jumps',()=>{
  let now=0,id=0;const queue=new Map(),draws=[];
  const p=new TrailPlayback({now:()=>now,request:fn=>{queue.set(++id,fn);return id;},cancel:id=>queue.delete(id),
    draw:(t,motion)=>draws.push({t,motion})});
  const tick=(time)=>{now=time;const [id,fn]=queue.entries().next().value;queue.delete(id);fn(time);};
  p.play();tick(500);assert.equal(p.time,.5);
  now=700;p.pause();assert.equal(p.time,.7);assert.equal(queue.size,0);
  now=100000;p.seek(4);assert.equal(p.time,4);
  p.inspect();tick(100400);assert.equal(p.time,4);assert.ok(draws.at(-1).motion.inspectElapsed>=.4);
  tick(103000);assert.equal(p.time,4);assert.equal(queue.size,0);
  p.play();tick(103500);assert.equal(p.time,4.5);
  p.seek(11.8);p.play();tick(104000);assert.equal(p.time,12);assert.equal(p.playing,false);assert.equal(queue.size,0);
  p.replay();tick(104500);assert.equal(p.time,.5);
  p.reset();assert.equal(queue.size,0);assert.equal(p.time,0);
});
