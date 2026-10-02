import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { triangleSpread } from '../src/engine/lookalikeQuiz.js';

test('fifteen independent trail questions meet the matching and cue limits', async () => {
  const difficulties=['easy','medium','hard','expert','master'];
  for(let i=0;i<15;i++) {
    const q=await generate({seed:'trail-audit-'+i,difficulty:difficulties[i%5],mode:'trail',movement:i%2?'classic':'go'});
    assert.equal(q.validation.ok,true,'question '+i);
    assert.equal(q.options.length,3);assert.equal(q.options.filter(o=>o.correct).length,1);
    assert.ok(q.validation.minDistance>=q.validation.minRequiredDistance);
    assert.ok(q.validation.minSeparation>=q.terrain.size*.25);assert.ok(triangleSpread(q.options)>=.18);
    assert.ok(q.validation.spread.spanX>=q.terrain.size*.30);
    assert.ok(q.validation.spread.spanY>=q.terrain.size*.30);
    assert.ok(q.validation.spread.diameter>=q.terrain.size*.45);
    for(const pair of q.trail.pairs) {
      assert.equal(pair.ok,true);assert.ok(pair.cue.magnitude>=q.validation.minCue);
      assert.ok(pair.cue.t<q.trail.duration);
    }
    for(const r of q.options) {
      assert.ok(r.terrainRun.relief>=6);
      assert.ok(Math.max(r.terrainRun.gradeRange,r.terrainRun.slopeRange)>=2.5);
      assert.ok(r.terrainRun.cellCount>=2);
    }
    for(const o of q.options.filter(o=>!o.correct)) {
      assert.ok(o.cue.magnitude>=q.validation.minCue);
      assert.ok(o.cue.t<q.trail.duration);
    }
  }
});
