import test from 'node:test';
import assert from 'node:assert/strict';
import { KNIVES, FINISHES, CHARACTERS, viewmodelMeshes, normaliseAppearance } from '../src/render/viewmodelMesh.js';
import { viewmodelPose, poseMatrix, inspectEnvelope } from '../src/render/knifeViewModel.js';
import { TrailPlayback } from '../src/ui/trailPlayback.js';

test('all knife, glove and finish meshes have finite geometry and unit normals',()=>{
  for(const knife of KNIVES)for(const character of CHARACTERS)for(const finish of FINISHES) {
    const meshes=viewmodelMeshes({knife:knife.id,character:character.id,finish:finish.id});
    for(const vertices of Object.values(meshes)) {
      assert.equal(vertices.length%30,0);assert.ok(vertices.length>=600);
      for(let i=0;i<vertices.length;i+=10) {
        assert.ok(Array.from(vertices.slice(i,i+10)).every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...vertices.slice(i+3,i+6))-1)<1e-5);
        assert.ok(vertices[i+9]>=0 && vertices[i+9]<=1);
      }
    }
  }
  assert.deepEqual(normaliseAppearance({knife:'<script>',character:'missing',finish:'bad',handedness:'other'}),
    {knife:'karambit',character:'tactical',finish:'steel',handedness:'right'});
});

test('knives have different silhouettes, and finishes change colour without changing shape',()=>{
  const meshes=KNIVES.map(k=>viewmodelMeshes({knife:k.id}).knife);
  for(let i=0;i<meshes.length;i++)for(let j=i+1;j<meshes.length;j++)assert.notDeepEqual(meshes[i],meshes[j]);
  const steel=viewmodelMeshes({knife:'huntsman',finish:'steel'}).knife,fade=viewmodelMeshes({knife:'huntsman',finish:'fade'}).knife;
  assert.equal(steel.length,fade.length);
  for(let i=0;i<steel.length;i+=10)assert.deepEqual(steel.slice(i,i+6),fade.slice(i,i+6));
  assert.notDeepEqual(steel,fade);
});

test('inspect is reproducible, eased, returns to rest and mirrors hands',()=>{
  for(const t of [-1,0,2.8,3])assert.equal(inspectEnvelope(t),0);
  assert.ok(inspectEnvelope(.6)>.95);
  for(const knife of KNIVES) {
    const o={knife:knife.id};
    for(const t of [0,1.25,2.5,4,7.8,10.2,12]) {
      const p=viewmodelPose(t,{speed:17,vertical:3,landing:.1},o);
      assert.deepEqual(p,viewmodelPose(t,{speed:17,vertical:3,landing:.1},o));
      for(const id of ['left','right','knife'])assert.ok(Array.from(poseMatrix(p[id])).every(Number.isFinite));
    }
    const a=viewmodelPose(0,{},o),b=viewmodelPose(5,{},o);
    for(let i=0;i<16;i++)assert.ok(Math.abs(poseMatrix(a.knife)[i]-poseMatrix(b.knife)[i])<1e-6);
    const left=viewmodelPose(0,{}, {...o,handedness:'left'});
    assert.equal(left.right.position[0],-a.right.position[0]);
    const r=poseMatrix(a.knife),l=poseMatrix(left.knife);
    for(let i=0;i<16;i++)assert.ok(Math.abs(l[i]-(i%4===0?-r[i]:r[i]))<1e-6);
  }
});

test('knives stay inside the first-person frame during idle and inspect',()=>{
  for(const knife of KNIVES)for(const handedness of ['left','right'])for(const aspect of [1.6,2])for(const t of [0,1.5,2.3,3.8,5,8.5]) {
    const o={knife:knife.id,handedness},vertices=viewmodelMeshes(o).knife,m=poseMatrix(viewmodelPose(t,{},o).knife);
    let visible=0;
    for(let i=0;i<vertices.length;i+=10) {
      const [x,y,z]=vertices.slice(i,i+3);
      const X=m[0]*x+m[4]*y+m[8]*z+m[12],Y=m[1]*x+m[5]*y+m[9]*z+m[13],Z=m[2]*x+m[6]*y+m[10]*z+m[14];
      const u=X/(-Z*Math.tan(76*Math.PI/360)),v=Y*aspect/(-Z*Math.tan(76*Math.PI/360));
      if(Math.abs(u)<=1 && Math.abs(v)<=1 && Z<-.02)visible++;
    }
    assert.ok(visible/(vertices.length/10)>.75,knife.id+' '+handedness+' aspect '+aspect+' t '+t);
  }
});


test('idle hands and knives leave the skyline cue strip unobstructed',()=>{
  const strip=Math.tan(7.5*Math.PI/180);
  for(const knife of KNIVES)for(const handedness of ['left','right'])for(const character of CHARACTERS)for(const time of [0,4.5,6,10.5,11.75]) {
    const o={knife:knife.id,character:character.id,handedness},pose=viewmodelPose(time,{speed:17,vertical:7,landing:1},o);
    for(const [id,vertices] of Object.entries(viewmodelMeshes(o))) {
      const m=poseMatrix(pose[id]);
      for(let i=0;i<vertices.length;i+=10) {
        const [x,y,z]=vertices.slice(i,i+3);
        const X=m[0]*x+m[4]*y+m[8]*z+m[12],Z=m[2]*x+m[6]*y+m[10]*z+m[14];
        assert.ok(Math.abs(X/(-Z*Math.tan(76*Math.PI/360)))>strip,
          knife.id+' '+handedness+' '+character.id+' '+id+' t '+time);
      }
    }
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
