import test from 'node:test';
import assert from 'node:assert/strict';
import { friendVideoZoom, exportCamera } from '../src/export/friendZoom.js';
import { ExportComposer, FORMATS } from '../src/export/composer.js';
import { createStage } from '../src/easter/stage.js';

const quiz = Object.freeze({ mode:'friend', camera:Object.freeze({x:40,y:90,z:23,heading:15,pitch:-4,roll:0,fov:50,eyeHeight:1.7}),
  friend:Object.freeze({x:80,y:160,z:20,height:1.8}), heading:{mode:'exact',text:'FACING 015°'}, correctLabel:'B',options:[{label:'A'},{label:'B'},{label:'C'}] });

test('friend video begins at 3 seconds, zooms over 2 seconds, holds 5 seconds and returns by the reveal',()=>{
  for(const t of [-1,0,1,3,12,13,449/30,15,NaN]) assert.equal(friendVideoZoom(t),1);
  assert.equal(friendVideoZoom(4),2);
  for(const t of [5,6,7,8,9,10]) assert.equal(friendVideoZoom(t),3);
  assert.equal(friendVideoZoom(11),2);
  let previous=1;
  for(let t=3;t<=5;t+=1/30) {const z=friendVideoZoom(t);assert.ok(z>=previous && z<=3);previous=z;}
  previous=3;
  for(let t=10;t<=12;t+=1/30) {const z=friendVideoZoom(t);assert.ok(z<=previous && z>=1);previous=z;}
  for(const t of [3,5,10,12]) {
    assert.ok(Math.abs(friendVideoZoom(t-.001)-friendVideoZoom(t))<.000002);
    assert.ok(Math.abs(friendVideoZoom(t+.001)-friendVideoZoom(t))<.000002);
  }
});

test('zoom changes focal length while preserving viewpoint, person and frozen quiz',()=>{
  const before=JSON.stringify(quiz);
  for(const t of [7,4,11,0,5,12,3.25,9]) {
    const c=exportCamera(quiz,t,true);
    for(const key of ['x','y','z','heading','pitch','roll','eyeHeight']) assert.equal(c[key],quiz.camera[key]);
    const opticalZoom=Math.tan(quiz.camera.fov*Math.PI/360)/Math.tan(c.fov*Math.PI/360);
    assert.ok(Math.abs(opticalZoom-friendVideoZoom(t))<1e-12);
    assert.deepEqual(c,exportCamera(quiz,t,true)); // frames may be requested out of order
  }
  assert.equal(JSON.stringify(quiz),before);
  for(const mode of ['where-am-i','grid','lookalike','facing']) assert.equal(exportCamera({...quiz,mode},7,true),quiz.camera);
  for(const t of [4,7,11]) assert.equal(exportCamera(quiz,t,false),quiz.camera);
  for(const t of [0,12,449/30,15]) assert.equal(exportCamera(quiz,t,true),quiz.camera);
});

function composer(format='reels') {
  const c=Object.create(ExportComposer.prototype),calls=[];
  c.quiz=quiz;c.canvas={...FORMATS[format],toBlob:cb=>cb('png')};
  c.ctx=new Proxy({measureText:()=>({width:20}),createLinearGradient:()=>({addColorStop:()=>{}})},{get:(target,key)=>target[key]??(()=>{}),set:(target,key,value)=>{target[key]=value;return true;}});
  c.layout=c.computeLayout(FORMATS[format]);
  c.options={duration:15,caption:false,tape:true,handle:''};
  c.weather={rain:false};c.animated=true;
  c.renderer={render:(camera,options)=>calls.push({camera,options})};
  c.glCanvas={};c.mapCanvas={};c.mapRevealCanvas={};
  return {c,calls};
}

test('both export formats use the zoom timeline and PNGs reset to 1x',async()=>{
  for(const format of ['reels','post']) {
    const {c,calls}=composer(format);
    for(const t of [0,4,7,11,12,449/30]) {
      c.drawFrame(t,{reveal:t>=12});
      assert.deepEqual(calls.at(-1).camera,exportCamera(quiz,t,true));
      assert.equal(calls.at(-1).options.time,t);
    }
    const png=await c.toImage({time:7});
    assert.equal(png,'png');assert.equal(c.animated,false);
    assert.equal(calls.at(-1).camera,quiz.camera);
    c.animated=true;c.drawFrame(7);
    assert.deepEqual(calls.at(-1).camera,exportCamera(quiz,7,true));
  }
});

test('seasonal sky clipping follows the zoom and restores the wide skyline',()=>{
  const {c}=composer();
  const S=c.layout.scene,wide=[[0,320],[S.w/2,280],[S.w,330]];
  const stage=createStage({layout:c.layout,frame:c.canvas,skyline:wide});
  const originalX=stage.skyX,originalY=stage.skyY,originalRaw=stage.skyRawY;
  const draws=[];c.easter={stage,draw:(_ctx,t)=>draws.push(t)};c.easterFov=quiz.camera.fov;
  const angles=[];
  c.model={skyline:{castRay:(x,y,z,az)=>{angles.push(az);return {angle:-3+Math.sin(az*Math.PI/180)};}}};
  c.drawFrame(7);
  assert.equal(stage.skyX,originalX);assert.equal(stage.skyY,originalY);assert.equal(stage.skyRawY,originalRaw);
  const zoomSpread=Math.max(...angles)-Math.min(...angles),zoomY=[...stage.skyY];
  const sampleCount=angles.length;
  c.drawFrame(8);assert.equal(angles.length,sampleCount); // stationary hold needs no ray recast
  angles.length=0;c.drawFrame(12,{reveal:true});
  const wideSpread=Math.max(...angles)-Math.min(...angles);
  assert.ok(wideSpread>zoomSpread*2.5);
  assert.notDeepEqual(stage.skyY,zoomY);assert.equal(c.easterFov,quiz.camera.fov);
  assert.deepEqual(draws,[7,8,12]);
});
