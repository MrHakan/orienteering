import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/engine/quiz.js';
import { FRIEND_HEIGHT, personSight } from '../src/engine/friendQuiz.js';
import { surfaceElevation, surfaceLineOfSight } from '../src/engine/terrainSurface.js';
import { TerrainModel } from '../src/engine/terrainModel.js';
import { MapRenderer, quizMarkers } from '../src/render/mapRenderer.js';
import { personVertices } from '../src/render/personMesh.js';
import { captionText } from '../src/export/composer.js';
import { scrambleLabels } from '../src/engine/scramble.js';

for (const difficulty of ['easy','medium','hard','expert','master']) for (const friendChallenge of ['standard','depth-trap']) {
  test(`${difficulty} ${friendChallenge} locates a visible person from a separate observer`, async () => {
    const q = await generate({seed:'friend-demo',mode:'friend',difficulty,friendChallenge});
    assert.equal(q.mode,'friend'); assert.equal(q.validation.ok,true);
    assert.equal(q.friend.challenge,friendChallenge);
    const model = new TerrainModel({...q.terrain,seed:q.terrain.modelSeed});
    const correct = q.options.find(p=>p.correct);
    assert.equal(q.options.filter(p=>p.correct).length,1);
    assert.equal(q.correctLabel,correct.label);
    assert.equal(q.friend.x,correct.x); assert.equal(q.friend.y,correct.y);
    assert.notEqual(q.camera.x,q.friend.x);
    assert.equal(q.friend.height,FRIEND_HEIGHT);
    assert.equal(q.friend.z,surfaceElevation(model,q.friend.x,q.friend.y));
    assert.ok(q.validation.minDistance >= q.validation.minRequiredDistance);
    for (const p of q.options) {
      const sight = personSight(model,q.camera,p);
      assert.equal(sight.visible,true); assert.ok(sight.distance>=65 && sight.distance<=230);
      assert.ok(model.getSlope(p.x,p.y)<=26);
      assert.ok(Math.abs(p.x-q.mapExtent.x)<q.mapExtent.size/2-45);
      assert.ok(Math.abs(p.y-q.mapExtent.y)<q.mapExtent.size/2-45);
    }
    if (friendChallenge==='depth-trap') {
      assert.ok(Math.max(...q.options.map(p=>p.bearing))-Math.min(...q.options.map(p=>p.bearing))<1e-8);
    }
    assert.equal(quizMarkers(q),q.options);
    assert.match(captionText(q),/From YOU, locate your friend/);
  });
}

test('friend replay, variants and scrambling preserve separate observer and subject', async () => {
  const opts={seed:'friend-replay',mode:'friend',friendChallenge:'depth-trap',headingMode:'cardinal'};
  const a=await generate(opts), b=await generate(opts), c=await generate({...opts,variant:1});
  assert.deepEqual(a.camera,b.camera); assert.deepEqual(a.friend,b.friend); assert.deepEqual(a.options,b.options);
  assert.deepEqual(a.terrain.heights,c.terrain.heights); assert.notDeepEqual(a.camera,c.camera);
  assert.equal(a.camera.heading%90,0);
  const s=scrambleLabels(a,2);
  assert.deepEqual(s.camera,a.camera); assert.deepEqual(s.friend,a.friend);
  assert.equal(s.options.find(p=>p.correct).x,a.friend.x);
  assert.equal(s.correctLabel,s.options.find(p=>p.correct).label);
});

test('local map rotation and hit testing preserve world coordinates and exclude YOU from choices', () => {
  const mr=Object.create(MapRenderer.prototype);
  mr.data={model:{size:2000},extent:{x:700,y:1200,size:400},observer:{x:550,y:1100},options:[{label:'A',x:660,y:1230},{label:'B',x:745,y:1290}]};
  mr.S=360;mr.cx=200;mr.cy=200;
  mr.canvas={getBoundingClientRect:()=>({left:10,top:20})};
  for(const angle of [0,90,180,270]) {
    mr.cos=Math.cos(angle*Math.PI/180);mr.sin=Math.sin(angle*Math.PI/180);
    for(const p of mr.data.options) {
      const [x,y]=mr.toCanvas(p.x,p.y),[wx,wy]=mr.toWorld(x,y);
      assert.ok(Math.abs(wx-p.x)<1e-8 && Math.abs(wy-p.y)<1e-8);
      assert.equal(mr.hit({clientX:x+10,clientY:y+20}).label,p.label);
    }
    const [x,y]=mr.toCanvas(550,1100);
    assert.equal(mr.hit({clientX:x+10,clientY:y+20}),null);
  }
});

test('person contacts the actual triangular surface; terrain can occlude him', () => {
  const model=new TerrainModel({size:100,n:3,heights:new Float32Array([0,0,0,0,20,0,0,0,0])});
  assert.equal(surfaceElevation(model,12.5,12.5),0);
  assert.equal(model.getElevation(12.5,12.5),1.25);
  assert.equal(surfaceElevation(model,37.5,37.5),10);
  assert.equal(surfaceLineOfSight(model,{x:5,y:50,z:2},{x:95,y:50,z:2}),false);
  assert.equal(surfaceLineOfSight(model,{x:5,y:50,z:30},{x:95,y:50,z:30}),true);
});

test('human mesh is a physical 1.80 m object with an orange torso and two legs', () => {
  const vertices=personVertices({x:100,y:200,z:50,height:FRIEND_HEIGHT,heading:0});
  const heights=[];let orange=0;
  for(let i=0;i<vertices.length;i+=9) {
    assert.ok(Array.from(vertices.slice(i,i+9)).every(Number.isFinite));
    heights.push(vertices[i+1]);
    assert.ok(Math.abs(vertices[i]-100)<=.35);
    assert.ok(Math.abs(vertices[i+2]+200)<=.16);
    if(vertices[i+6]>.9 && vertices[i+7]<.3) orange++;
  }
  assert.ok(Math.abs(Math.max(...heights)-51.8)<1e-5);
  assert.ok(Math.abs(Math.min(...heights)-50.015)<1e-5);
  assert.ok(orange>=36);
});

test('friend mode refuses unvalidated terrain',async()=>{
  await assert.rejects(generate({seed:'none',mode:'friend',maxTerrainAttempts:0}),/No clear friend sighting/);
});
