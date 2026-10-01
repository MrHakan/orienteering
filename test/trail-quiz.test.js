import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { Random } from '../src/engine/rng.js';
import { surfaceElevation } from '../src/engine/terrainSurface.js';
import { createTrailPlan, simulateTrail, trailFrame, airAccelerate, MOVEMENT_PROFILES, METRES_PER_UNIT } from '../src/engine/trailMotion.js';
import { TRAIL_COLORS, compareTrailViews } from '../src/engine/trailQuiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { MapRenderer, trailTracePoints } from '../src/render/mapRenderer.js';
import { ExportComposer, FORMATS } from '../src/export/composer.js';

for (const difficulty of ['easy','medium','hard','expert','master']) for (const movement of ['classic','go']) {
  test(`${difficulty} ${movement}: three matched, walkable, distinguishable trails`, async () => {
    const q=await generate({seed:'bhop-demo',mode:'trail',difficulty,movement});
    const model=new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
    assert.equal(q.mode,'trail');assert.equal(q.validation.ok,true);
    assert.deepEqual(q.mapExtent,{x:model.size/2,y:model.size/2,size:model.size});
    assert.equal(q.trail.movement,movement);assert.equal(q.options.length,3);
    assert.equal(q.options.filter(o=>o.correct).length,1);
    assert.equal(q.correctLabel,q.options.find(o=>o.correct).label);
    assert.ok(q.validation.minDistance>=q.validation.minRequiredDistance);
    assert.ok(q.validation.minSeparation>=240);assert.ok(q.stats.questionsCompared>0);
    for(const o of q.options) {
      assert.ok(o.landings.length>=8);assert.ok(o.maxSlope<=24);
      assert.equal(o.points.length,97);
      for(let i=0;i<o.points.length;i++) {
        const other=q.options[(q.options.indexOf(o)+1)%3];
        assert.ok(Math.abs((o.points[i].x-o.x)-(other.points[i].x-other.x))<1e-8);
        assert.ok(Math.abs((o.points[i].y-o.y)-(other.points[i].y-other.y))<1e-8);
      }
      for(let t=0;t<=12;t+=.125) {
        const {camera,motion}=trailFrame(q,t,o.label,model);
        assert.ok(Object.values(camera).every(Number.isFinite));
        assert.ok(model.inside(camera.x,camera.y,65));
        assert.ok(camera.z>=surfaceElevation(model,camera.x,camera.y)+camera.eyeHeight-1e-8);
        assert.ok(motion.speed>=6.3 && motion.speed<=700*METRES_PER_UNIT+1e-8);
      }
      if(!o.correct) {
        assert.ok(o.cue.magnitude>=q.validation.minCue);
        assert.ok(o.cue.t<12);
        assert.ok(!(o.cue.t>=1.2 && o.cue.t<=4) && !(o.cue.t>=7.4 && o.cue.t<=10.2));
        for(const label of [q.correctLabel,o.label]) {
          const {camera}=trailFrame(q,o.cue.t,label,model);
          const view=model.skyline.viewDescriptor(camera.x,camera.y,camera.heading,camera.fov,{
            eyeHeight:camera.z-model.getElevation(camera.x,camera.y),columns:33});
          const offset=((o.cue.bearing-camera.heading+540)%360)-180;
          const column=Math.round((offset+45)/90*32);
          assert.ok(Math.abs(offset)<=5);
          assert.ok(Math.abs(view.horizon[column]-camera.pitch)<25);
        }
      }
    }
  });
}

test('gravity yields the correct parabola and queued hops preserve horizontal motion',()=>{
  const model=new TerrainModel({size:2000,n:2,heights:new Float32Array(4)});
  const plan=createTrailPlan(new Random('flat-physics'),0);
  for(const movement of ['classic','go']) {
    const route=simulateTrail(model,{x:800,y:800},plan,movement);
    const profile=MOVEMENT_PROFILES[movement];
    const k=32,t=k*plan.dt;
    assert.ok(Math.abs(route.feet[k]-(profile.jump*t-.5*profile.gravity*t*t))<1e-9);
    const peak=Math.max(...route.feet);
    assert.ok(Math.abs(peak-profile.jump**2/(2*profile.gravity))<.001);
    for(const l of route.landings) assert.ok(Math.abs(l.flight-2*profile.jump/profile.gravity)<plan.dt+.001);
    assert.ok(plan.length>150 && plan.length<220);
    const frame=trailFrame({options:[{...route,label:'A',correct:true}],correctLabel:'A',
      trail:{plan},camera:{eyeHeight:1.7,fov:90,pitch:-2,heading:0}},.25,'A',model);
    assert.ok(frame.camera.y>800);assert.ok(frame.camera.z>1.7);
  }
});

test('air wish-speed is a projection cap, not a total-speed cap',()=>{
  assert.deepEqual(airAccelerate(5,0,1,0,.05),[5,0]);
  const [x,y]=airAccelerate(5,0,0,1,.05);
  assert.equal(x,5);assert.ok(y>0);assert.ok(Math.hypot(x,y)>5);
  assert.ok(y<=30*METRES_PER_UNIT);
});

test('trail replay and random-access frames survive new positions and scrambling',async()=>{
  const opts={seed:'bhop-replay',mode:'trail',difficulty:'medium'};
  const a=await generate(opts),b=await generate(opts),c=await generate({...opts,variant:1});
  assert.deepEqual(a.camera,b.camera);assert.deepEqual(a.options,b.options);assert.deepEqual(a.trail,b.trail);
  assert.deepEqual(a.terrain.heights,c.terrain.heights);assert.notDeepEqual(a.camera,c.camera);
  const model=new TerrainModel({...a.terrain,seed:a.terrain.modelSeed});
  const frames=[11.5,0,5.25,2.75].map(t=>trailFrame(a,t,a.correctLabel,model));
  for(const [i,t] of [11.5,0,5.25,2.75].entries())assert.deepEqual(frames[i],trailFrame(a,t,a.correctLabel,model));
  const s=scrambleLabels(a,3);
  for(const t of [0,1.5,8,12])assert.deepEqual(trailFrame(a,t,a.correctLabel,model).camera,trailFrame(s,t,s.correctLabel,model).camera);
  assert.deepEqual(TRAIL_COLORS,{A:'#ff6358',B:'#58d68b',C:'#39d5ed'});
  assert.deepEqual(trailFrame(a,15,a.correctLabel,model).camera,trailFrame(a,12,a.correctLabel,model).camera);
});

test('pairwise terrain differences are symmetric and contain a timed visible cue',async()=>{
  const q=await generate({seed:'bhop-pairs',mode:'trail',difficulty:'master'});
  const model=new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
  const described=q.options.map(route=>({...route,views:q.trail.times.map(t=>{
    const {camera}=trailFrame(q,t,route.label,model);
    const descriptor=model.skyline.viewDescriptor(camera.x,camera.y,camera.heading,camera.fov,{
      eyeHeight:camera.z-model.getElevation(camera.x,camera.y),columns:33});
    return {...descriptor,pitchOffset:camera.pitch-q.camera.pitch};
  })}));
  const band={min:.7,max:3.5,cue:.9,profile:3.4};
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++) {
    const ab=compareTrailViews(described[i],described[j],band,q.trail.times);
    const ba=compareTrailViews(described[j],described[i],band,q.trail.times);
    assert.equal(ab.ok,true);assert.equal(ba.ok,true);
    assert.ok(Math.abs(ab.D-ba.D)<1e-12);
    assert.ok(Math.abs(ab.cue.delta+ba.cue.delta)<1e-12);
    assert.ok(ab.cue.t<12);
  }
  // Equal screen angles are not a clue, even if world skyline angles differ.
  const a=described[0],b={...a,views:a.views.map(d=>({...d,
    horizon:Float32Array.from(d.horizon,h=>h+.4),pitchOffset:(d.pitchOffset||0)+.4}))};
  const cancelled=compareTrailViews(a,b,{min:.01,max:10,cue:.1,profile:10},q.trail.times);
  assert.ok(cancelled.cue.magnitude<1e-5);assert.equal(cancelled.ok,false);
});

test('trail segment hit testing respects rotated and cropped maps',()=>{
  const mr=Object.create(MapRenderer.prototype);
  mr.data={model:{size:2000},extent:{x:700,y:1000,size:650},trails:true,options:[
    {label:'A',x:600,y:900,points:[{x:600,y:900},{x:650,y:1050},{x:750,y:1100}]},
    {label:'B',x:800,y:800,points:[{x:800,y:800},{x:860,y:870}]}]};
  mr.S=360;mr.cx=200;mr.cy=200;mr.canvas={getBoundingClientRect:()=>({left:10,top:20})};
  for(const angle of [0,90,180,270]) {
    mr.cos=Math.cos(angle*Math.PI/180);mr.sin=Math.sin(angle*Math.PI/180);
    const [x,y]=mr.toCanvas(625,975);
    assert.equal(mr.hit({clientX:x+10,clientY:y+20}).label,'A');
    const [u,v]=mr.toCanvas(950,1200);
    assert.equal(mr.hit({clientX:u+10,clientY:v+20}),null);
  }
});

test('question trails never expose the correct flag through style or the moving dot',()=>{
  const calls=[];
  const ctx=new Proxy({},{
    get:(o,k)=>o[k]??((...args)=>calls.push([k,...args])),
    set:(o,k,v)=>{o[k]=v;calls.push([k,v]);return true;},
  });
  const mr=Object.create(MapRenderer.prototype);mr.ctx=ctx;mr.pickable=true;mr.hover=null;mr.reveal=null;
  mr.viewing={x:5,y:8,label:'B'};mr.toCanvas=(x,y)=>[x,y];
  const options=['A','B','C'].map((label,i)=>({label,correct:i===0,points:[{x:i*100,y:10},{x:i*100+50,y:80}]}));
  mr.data={options};mr.drawTrails();const before=JSON.stringify(calls);
  calls.length=0;mr.data.options=options.map(o=>({...o,correct:!o.correct}));mr.drawTrails();
  assert.equal(JSON.stringify(calls),before);
  assert.ok(!calls.some(c=>c[0]==='arc'));
  calls.length=0;mr.reveal={};mr.drawTrails();assert.ok(calls.some(c=>c[0]==='arc'));
});

test('both video formats share the live route sampler and freeze at the end for reveal',async()=>{
  const q=await generate({seed:'bhop-export',mode:'trail',difficulty:'medium'});
  const model=new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
  for(const format of ['reels','post']) {
    const c=Object.create(ExportComposer.prototype),calls=[];
    c.quiz=q;c.model=model;c.canvas={...FORMATS[format],toBlob:cb=>cb('png')};
    c.ctx=new Proxy({measureText:()=>({width:20})},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>{o[k]=v;return true;}});
    c.layout=c.computeLayout(FORMATS[format]);c.options={duration:15,caption:true,tape:false,handle:''};
    c.weather={rain:false};c.animated=true;
    c.renderer={prepareEnvironmentReady:async()=>{},render:(camera,options)=>calls.push({camera,options})};
    c.glCanvas={};c.mapCanvas={};c.mapRevealCanvas={};
    const mapCalls=[];c.trailRevealMap={setViewing:camera=>mapCalls.push(camera)};c.trailRevealMapTime=-1;
    for(const t of [0,2.5,6,10.75,12,14.95]) {
      c.drawFrame(t,{reveal:t>=12});
      assert.deepEqual(calls.at(-1).camera,trailFrame(q,t,q.correctLabel,model).camera);
      assert.equal(calls.at(-1).options.time,Math.min(t,12));
      assert.equal(calls.at(-1).options.sunHeading,q.camera.heading);
    }
    await c.toImage({time:4});
    assert.deepEqual(calls.at(-1).camera,trailFrame(q,4,q.correctLabel,model).camera);
    await c.toImage({reveal:true,time:4});
    assert.deepEqual(mapCalls.at(-1),{...trailFrame(q,4,q.correctLabel,model).camera,label:q.correctLabel});
  }
});

test('trail generation refuses a broken or unvalidated question',async()=>{
  await assert.rejects(generate({seed:'none',mode:'trail',maxTerrainAttempts:0}),/No fair three-trail/);
});


test('all three question traces progress together without exposing correctness',()=>{
  const calls=[], ctx=new Proxy({},{get:(o,k)=>o[k]??((...args)=>calls.push([k,...args])),
    set:(o,k,v)=>{o[k]=v;calls.push([k,v]);return true;}});
  const mr=Object.create(MapRenderer.prototype);
  Object.assign(mr,{ctx,pickable:true,hover:null,reveal:null,viewing:null,toCanvas:(x,y)=>[x,y]});
  const options=['A','B','C'].map((label,i)=>({label,correct:i===0,points:[{x:i*100,y:0},{x:i*100+60,y:0},{x:i*100+120,y:0}]}));
  mr.data={options,trailDuration:12};
  for(const time of [1.3,6,11.9]) {
    mr.trailTime=time;calls.length=0;mr.drawTrails();const before=JSON.stringify(calls);
    assert.equal(calls.filter(c=>c[0]==='arc').length,3);
    mr.data.options=options.map(o=>({...o,correct:!o.correct}));calls.length=0;mr.drawTrails();
    assert.equal(JSON.stringify(calls),before);
    assert.deepEqual(trailTracePoints(options[0].points,time).at(-1),{x:time*10,y:0});
  }
  assert.deepEqual(trailTracePoints(options[0].points,-1),[options[0].points[0]]);
  assert.deepEqual(trailTracePoints(options[0].points,99),options[0].points);
});
