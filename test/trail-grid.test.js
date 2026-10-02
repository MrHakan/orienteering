import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { trailFrame, simulateTrail } from '../src/engine/trailMotion.js';
import { cellAtExtent } from '../src/engine/gridQuiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { ExportComposer, FORMATS, captionText } from '../src/export/composer.js';

for(const [gridSize,difficulty,movement] of [[4,'easy','go'],[6,'medium','go'],[6,'expert','classic'],[8,'hard','classic'],[16,'master','go']]) {
  test(gridSize+' grid '+difficulty+': finish at cell centre, full-sequence cues for every possible alternative',async()=>{
    const q=await generate({seed:'bhop-grid',mode:'trail',trailAnswer:'grid',gridSize,difficulty,movement});
    const model=new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
    assert.equal(q.trail.answerMode,'grid');assert.equal(q.grid.size,gridSize);
    assert.equal(q.options.length,gridSize**2);
    assert.equal(q.options.filter(o=>o.correct).length,1);
    assert.equal(q.stats.cellsChecked,gridSize**2);
    assert.deepEqual(quizMarkers(q),[]);assert.equal(q.trail.routes.length,1);
    const actual=q.trail.routes[0],cell=q.options.find(o=>o.correct);
    const end=trailFrame(q,12,q.correctLabel,model).camera;
    assert.ok(Math.abs(end.x-cell.x)<1e-9 && Math.abs(end.y-cell.y)<1e-9);
    assert.equal(cellAtExtent(end.x,end.y,q.mapExtent,gridSize),q.correctLabel);
    assert.deepEqual(q.grid.target,{x:cell.x,y:cell.y,label:'FINISH'});
    assert.ok(q.validation.minDistance>=q.validation.minRequiredDistance);
    assert.equal(q.trail.pairs.length,q.stats.routesChecked-1);
    for(const pair of q.trail.pairs) {
      assert.ok(pair.D>=q.validation.minRequiredDistance);
      assert.ok(pair.cue.magnitude>=q.validation.minCue);
      assert.equal(pair.visible,true);
      const other=q.options.find(o=>o.label===pair.label);
      const offset=simulateTrail(model,{x:actual.x+other.x-cell.x,y:actual.y+other.y-cell.y},q.trail.plan,movement);
      assert.ok(offset);
      for(const route of [actual,offset]) {
        const frame=trailFrame({...q,trail:{...q.trail,routes:[{...route,label:q.correctLabel,correct:true}]}},pair.cue.t,q.correctLabel,model);
        const cam=frame.camera,view=model.skyline.viewDescriptor(cam.x,cam.y,cam.heading,cam.fov,{
          eyeHeight:cam.z-model.getElevation(cam.x,cam.y),columns:33});
        const relative=((pair.cue.bearing-cam.heading+540)%360)-180;
        assert.ok(Math.abs(relative)<=5);
        const column=Math.max(0,Math.min(32,Math.round((relative+45)/90*32)));
        assert.ok(Math.abs(view.horizon[column]-cam.pitch)<25);
      }
    }
    for(const t of [12,0,7.25,2.5,11.9,15]) {
      const {camera,motion}=trailFrame(q,t,q.correctLabel,model);
      assert.ok(Object.values(camera).every(Number.isFinite));assert.ok(model.inside(camera.x,camera.y,65));
      assert.equal(q.correctLabel,cell.label);assert.equal(motion.t,Math.min(t,12));
    }
    assert.equal(scrambleLabels(q,3),q);
  });
}

test('grid route plan and answer survive replay, new positions and appearance changes',async()=>{
  const opts={seed:'bhop-grid',mode:'trail',trailAnswer:'grid',gridSize:6,difficulty:'medium'};
  const a=await generate(opts),b=await generate(opts),c=await generate({...opts,variant:1});
  assert.deepEqual(a.camera,b.camera);assert.deepEqual(a.trail,b.trail);
  assert.deepEqual(a.terrain.heights,c.terrain.heights);assert.notDeepEqual(a.camera,c.camera);
  const model=new TerrainModel({...a.terrain,seed:a.terrain.modelSeed});
  const cosmetic={...a,appearance:{knife:'butterfly',handedness:'left',scale:1.15}};
  for(const t of [0,4,9,12])assert.deepEqual(trailFrame(a,t,a.correctLabel,model).camera,trailFrame(cosmetic,t,a.correctLabel,model).camera);
});

test('grid question hides all path and target clues; reveal labels finish separately from replay',()=>{
  const calls=[],ctx=new Proxy({},{get:(o,k)=>o[k]??((...a)=>calls.push([k,...a])),set:(o,k,v)=>{o[k]=v;return true;}});
  const mr=Object.create(MapRenderer.prototype);
  Object.assign(mr,{ctx,pickable:true,reveal:null,viewing:{x:2,y:3,label:'B3'},toCanvas:(x,y)=>[x,y],
    data:{grid:{size:6,target:{x:8,y:9,label:'FINISH'}},options:[],routes:[{label:'B3',correct:true,x:1,y:1,points:[{x:1,y:1},{x:8,y:9}]}]}});
  for(const t of [0,5,12]){mr.trailTime=t;mr.drawTrails();mr.drawTrailLabels();mr.drawGridTarget();}
  assert.deepEqual(calls,[]);
  mr.draw=()=>{};mr._trailBase={};mr.setSelection('A1');assert.equal(mr._trailBase,null);
  mr._trailBase={};mr.setReveal({chosen:'A1'});assert.equal(mr._trailBase,null);
  mr.drawTrails();mr.drawTrailLabels();mr.drawGridTarget();
  assert.ok(calls.some(c=>c[0]==='fillText'&&c[1]==='FINISH'));
  assert.ok(calls.some(c=>c[0]==='fillText'&&c[1]==='START'));
  assert.ok(!calls.some(c=>c[0]==='fillText'&&c[1]==='B3'));
  calls.length=0;mr.data.grid.target={x:8,y:9};mr.drawGridTarget();
  assert.ok(calls.some(c=>c[0]==='fillText'&&c[1]==='FRIEND'));
});

test('both grid export formats use actual motion, finish-cell captions and terminal PNG by default',async()=>{
  const q=await generate({seed:'bhop-grid',mode:'trail',trailAnswer:'grid',gridSize:6,difficulty:'medium'});
  const model=new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
  assert.equal(captionText(q),'Find your finish cell: A1–F6.');
  for(const format of ['reels','post']) {
    const c=Object.create(ExportComposer.prototype),calls=[],texts=[];
    c.quiz=q;c.model=model;c.canvas={...FORMATS[format],toBlob:cb=>cb('png')};
    c.ctx=new Proxy({measureText:()=>({width:20}),fillText:t=>texts.push(t)},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>{o[k]=v;return true;}});
    c.layout=c.computeLayout(FORMATS[format]);c.options={duration:15,caption:true,tape:false,handle:''};
    c.weather={rain:false};c.animated=true;
    c.renderer={prepareEnvironmentReady:async()=>{},render:(camera,options)=>calls.push({camera,options})};
    c.glCanvas={};c.mapCanvas={};c.mapRevealCanvas={};
    const maps=[];c.trailRevealMap={setTrailTime:(t,v)=>maps.push({t,v}),setViewing:()=>{}};
    for(const t of [0,5,11.75,12,14.95]) {
      texts.length=0;c.drawFrame(t,{reveal:t>=12});
      assert.deepEqual(calls.at(-1).camera,trailFrame(q,t,q.correctLabel,model).camera);
      assert.ok(texts.includes(t>=12?'Answer: '+q.correctLabel:captionText(q)));
      assert.ok(texts.includes('WHERE DID YOU FINISH?'));
    }
    await c.toImage();assert.deepEqual(calls.at(-1).camera,trailFrame(q,12,q.correctLabel,model).camera);
    await c.toImage({time:4,reveal:true});
    assert.deepEqual(calls.at(-1).camera,trailFrame(q,4,q.correctLabel,model).camera);
    assert.equal(maps.at(-1).v.label,q.correctLabel);
    assert.deepEqual(q.grid.target,{x:q.options.find(o=>o.correct).x,y:q.options.find(o=>o.correct).y,label:'FINISH'});
  }
});

test('grid generation refuses an unvalidated run',async()=>{
  await assert.rejects(generate({seed:'none',mode:'trail',trailAnswer:'grid',maxTerrainAttempts:0}),/No unambiguous/);
});
