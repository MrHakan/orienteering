// Optional browser checks; Playwright is a CI/dev dependency only.
// CHECK_SITE=_site tests the versioned release that Pages actually deploys.
// node scripts/check-trail-browser.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/engine/quiz.js';
import { scrambleLabels } from '../src/engine/scramble.js';
import { planAt } from '../src/engine/trailMotion.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL(process.env.CHECK_SITE ? '../' + process.env.CHECK_SITE + '/' : '..', import.meta.url));
const out = process.argv[2];
if (out) await mkdir(out, { recursive: true });
const types = { '.mp4': 'video/mp4', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req,res) => {
  const path = normalize(decodeURIComponent(new URL(req.url,'http://localhost').pathname)).replace(/^[/\\]+/,'') || 'index.html';
  if (path.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join(root,path));
    const headers={'Content-Type':types[extname(path)] || 'application/octet-stream','Accept-Ranges':'bytes'};
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range) {
      const start=Number(range[1]),end=Math.min(body.length-1,range[2]?Number(range[2]):body.length-1);
      if(start>end){res.writeHead(416,{'Content-Range':`bytes */${body.length}`}).end();return;}
      res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${body.length}`,'Content-Length':end-start+1});res.end(body.subarray(start,end+1));
    } else { res.writeHead(200,{...headers,'Content-Length':body.length});res.end(body); }
  } catch { res.writeHead(404).end(); }
}).listen(0);
await new Promise(resolve=>server.once('listening',resolve));
const browser = await chromium.launch({
  ...(process.env.CHROME_EXECUTABLE ? { executablePath:process.env.CHROME_EXECUTABLE } : {}),
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
});
const errors = [];
const context = await browser.newContext({ viewport:{width:1280,height:1050},reducedMotion:'reduce',acceptDownloads:true });
const page = await context.newPage();
const watch = p => {
  p.on('pageerror',e=>errors.push(e.message));
  p.on('response',r=>{ if (r.status()>=400 && /\.js($|\?)/.test(r.url())) errors.push('Missing module: '+r.url()); });
};
watch(page);
const url='http://localhost:'+server.address().port;
const ready=(p,title)=>p.waitForFunction(title=>
  document.getElementById('loading').classList.contains('hidden')
  && (!title || document.getElementById('quiz-title').textContent===title),title,{timeout:180000});
const seek=(p,time)=>p.locator('#trail-scrub').evaluate((el,time)=>{
  el.value=String(time);el.dispatchEvent(new Event('input',{bubbles:true}));
},time);
const screenshot=async(p,name)=>{ if(out) await p.locator('.card').screenshot({path:join(out,name+'.png')}); };

try {
  let q=await generate({seed:'bhop-demo',mode:'trail',difficulty:'medium'});
  await page.goto(url+'/#seed=bhop-demo&d=medium&m=trail&k=classic');
  await ready(page,'WHICH TRAIL DID YOU FOLLOW?');
  assert.equal(await page.locator('#scene-error').isVisible(),false);
  assert.equal(await page.locator('#trail-tools').isVisible(),true);
  assert.equal(await page.locator('#movement-field').isVisible(),true);
  assert.equal(await page.locator('#heading-field').isVisible(),false);
  assert.equal(await page.locator('#answers .trail-choice').count(),3);
  assert.deepEqual(await page.locator('#answers button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),
    ['A — red trail','B — green trail','C — cyan trail']);
  assert.equal(await page.locator('#trail-play').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('#trail-scrub').inputValue(),'0');
  if(process.env.CHECK_SITE)assert.match(await page.locator('script[type="module"]').getAttribute('src'),/assets\/[a-f0-9]{40}\/src\/ui\/app\.js/);
  await screenshot(page,'trail-desktop-question');
  const initialScene=await page.locator('#scene').screenshot();
  const questionMap=await page.locator('#map').evaluate(c=>c.toDataURL());
  await seek(page,6);
  assert.equal(await page.locator('#trail-scrub').inputValue(),'6');
  assert.notDeepEqual(await page.locator('#scene').screenshot(),initialScene);
  assert.notEqual(await page.locator('#map').evaluate(c=>c.toDataURL()),questionMap);
  await page.locator('#quiz-title').click();
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.getElementById('trail-play').getAttribute('aria-pressed')==='true'
    && Number(document.getElementById('trail-scrub').value)>6.2);
  await page.locator('#trail-play').click();
  assert.equal(await page.locator('#trail-play').getAttribute('aria-pressed'),'false');
  await seek(page,6);
  const beforeInspect=await page.locator('#scene').screenshot();
  await page.locator('#quiz-title').click();await page.keyboard.press('f');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#trail-scrub').inputValue(),'6');
  assert.notDeepEqual(await page.locator('#scene').screenshot(),beforeInspect);
  await page.locator('.trail-customise summary').click();
  const mapAtSix=await page.locator('#map').evaluate(c=>c.toDataURL());
  for(const knife of ['classic','default','butterfly']) {
    await page.locator('#trail-knife').selectOption(knife);
    assert.match(page.url(),new RegExp('k='+knife));
    assert.equal(await page.locator('#loading').evaluate(el=>el.classList.contains('hidden')),true);
  }
  await page.locator('#trail-scale').selectOption('0.8');
  await page.locator('#trail-hand').selectOption('left');
  assert.match(page.url(),/ks=0.8/);assert.match(page.url(),/hand=left/);
  assert.equal(await page.locator('#map').evaluate(c=>c.toDataURL()),mapAtSix);
  await screenshot(page,'trail-customisation');
  await page.locator('#scramble').click();q=scrambleLabels(q,1);
  assert.match(page.url(),/s=1/);
  assert.equal(await page.locator('#trail-scrub').inputValue(),'6');

  // Select a segment, not only a start marker. Keep it away from neighbours.
  const wrong=q.options.find(o=>!o.correct);
  const segmentDistance=(p,a,b)=>{
    const dx=b.x-a.x,dy=b.y-a.y,k=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(p.x-a.x-k*dx,p.y-a.y-k*dy);
  };
  const safe=wrong.points.slice(12,-12).map(p=>({p,d:Math.min(...q.options.filter(o=>o!==wrong)
    .flatMap(o=>o.points.slice(1).map((b,i)=>segmentDistance(p,o.points[i],b))))})).sort((a,b)=>b.d-a.d)[0].p;
  await page.locator('#map').scrollIntoViewIfNeeded();
  const box=await page.locator('#map').boundingBox(),s=Math.min(box.width,box.height)-2*Math.max(14,Math.min(box.width,box.height)*.035);
  const a=q.mapRotation*Math.PI/180,u=(safe.x-q.mapExtent.x)/q.mapExtent.size,v=(q.mapExtent.y-safe.y)/q.mapExtent.size;
  await page.locator('#map').click({position:{x:box.width/2+(u*Math.cos(a)-v*Math.sin(a))*s,y:box.height/2+(u*Math.sin(a)+v*Math.cos(a))*s}});
  assert.match(await page.locator('#result .verdict').textContent(),new RegExp('Not quite — you followed trail '+q.correctLabel));
  // Answering while paused must reveal the white position dot immediately.
  const actual=q.options.find(o=>o.correct), position=planAt(q.trail.plan,Number(await page.locator('#trail-scrub').inputValue()));
  assert.equal(await page.locator('#map').evaluate((canvas,{x,y,rotation,extent})=>{
    const w=canvas.clientWidth,h=canvas.clientHeight,s=Math.min(w,h)-2*Math.max(14,Math.min(w,h)*.035);
    const a=rotation*Math.PI/180,u=(x-extent.x)/extent.size,v=(extent.y-y)/extent.size,dpr=canvas.width/w;
    const px=(w/2+(u*Math.cos(a)-v*Math.sin(a))*s)*dpr,py=(h/2+(u*Math.sin(a)+v*Math.cos(a))*s)*dpr;
    const pixels=canvas.getContext('2d').getImageData(Math.round(px)-2,Math.round(py)-2,5,5).data;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i]===255&&pixels[i+1]===255&&pixels[i+2]===255)return true;
    return false;
  },{x:actual.x+position.x,y:actual.y+position.y,rotation:q.mapRotation,extent:q.mapExtent}),true);
  assert.equal(await page.locator('#result [data-view]').count(),3);
  assert.equal(await page.locator('#result [data-cue]').count(),4);
  await page.locator('#result [data-cue][data-actual]').first().click();
  const cueLabel=await page.locator('#result [data-cue][data-actual]').first().getAttribute('data-cue');
  const cue=q.options.find(o=>o.label===cueLabel).cue;
  assert.equal(Number(await page.locator('#trail-scrub').inputValue()),cue.t);
  assert.match(await page.locator('#viewing-badge').textContent(),/actual run/);
  await page.locator('#result [data-cue]:not([data-actual])').first().click();
  assert.equal(Number(await page.locator('#trail-scrub').inputValue()),cue.t);
  assert.match(await page.locator('#viewing-badge').textContent(),/comparison/);
  await page.locator('#result [data-view]').last().click();
  assert.equal(await page.locator('#trail-play').getAttribute('aria-pressed'),'true');
  await page.locator('#trail-play').click();
  await screenshot(page,'trail-desktop-answer');

  await page.locator('#open-export').click();
  assert.equal(await page.locator('#export-dialog').isVisible(),true);
  assert.equal(await page.locator('#trail-play').getAttribute('aria-pressed'),'false');
  await page.locator('#export-easter').selectOption('off');
  await page.locator('[name="format"][value="post"]').check();
  await page.waitForFunction(()=>document.getElementById('export-canvas').height===1350);
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#export-png').click();
  const download=await downloadPromise;
  assert.match(download.suggestedFilename(),/\.png$/);
  if(out)await download.saveAs(join(out,'trail-ui-export-post.png'));
  await page.locator('#export-close').click();

  const mobile=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:2,reducedMotion:'reduce'});
  watch(mobile);
  await mobile.goto(url+'/#seed=bhop-demo&d=medium&m=trail&mv=classic&k=classic&hand=left');
  await ready(mobile,'WHICH TRAIL DID YOU FOLLOW?');
  assert.equal(await mobile.locator('#movement').inputValue(),'classic');
  assert.equal(await mobile.locator('#trail-hand').inputValue(),'left');
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mobile.locator('.trail-customise summary').tap();
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await seek(mobile,4.5);await screenshot(mobile,'trail-mobile-question');
  await mobile.locator('#trail-inspect').tap();await mobile.waitForTimeout(400);
  assert.equal(await mobile.locator('#trail-scrub').inputValue(),'4.5');
  await mobile.locator('#answers [data-label="B"]').tap();
  assert.equal(await mobile.locator('#result').isVisible(),true);
  await screenshot(mobile,'trail-mobile-answer');await mobile.close();

  // Audit rendered pixels, including the unobstructed cue strip.
  const original=await generate({seed:'bhop-demo',mode:'trail',difficulty:'medium'});
  const plain=JSON.parse(JSON.stringify(original,(key,value)=>ArrayBuffer.isView(value)?Array.from(value):value));
  const audit=await page.evaluate(async q=>{
    const src=new URL('../',document.querySelector('script[type="module"]').src);
    const {TerrainModel}=await import(new URL('engine/terrainModel.js',src));
    const {TerrainRenderer}=await import(new URL('render/webglTerrain.js',src));
    const {trailFrame}=await import(new URL('engine/trailMotion.js',src));
    const {ExportComposer}=await import(new URL('export/composer.js',src));
    const {encodeCanvasVideo}=await import(new URL('export/recorder.js',src));
    const model=new TerrainModel({...q.terrain,heights:new Float32Array(q.terrain.heights),seed:q.terrain.modelSeed});
    const canvas=document.createElement('canvas'),r=new TerrainRenderer(canvas);r.setTerrain(model);
    const result={clips:[],exports:[],video:null};
    const read=()=>{const p=new Uint8Array(canvas.width*canvas.height*4);r.gl.readPixels(0,0,canvas.width,canvas.height,r.gl.RGBA,r.gl.UNSIGNED_BYTE,p);return p;};
    const frame=trailFrame(q,0,q.correctLabel,model);
    for(const aspect of [1.6,2]) {
      r.setFixedSize(640,640/aspect);
      for(const knife of ['classic','default','butterfly'])for(const handedness of ['right','left'])for(const scale of [1,1.15]) {
        const appearance={knife,handedness,scale};
        r.setViewmodel(appearance);
        await r.prepareViewmodel(0,frame.motion);
        // Compare only the overlay pass on this exact terrain framebuffer.
        // Comparing against an earlier terrain render can count tiny raster
        // differences after inspect/camera changes as knife occlusion.
        r.setViewmodel(null);
        r.render(frame.camera,{time:0,motion:frame.motion,sunHeading:q.camera.heading});
        const base=read();
        r.setViewmodel(appearance);
        r.viewmodel.render(canvas.width,canvas.height,0,frame.motion);
        const pixels=read();let changed=0,protectedPixels=0;
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++) {
          const i=(y*canvas.width+x)*4;
          if(pixels[i]!==base[i] || pixels[i+1]!==base[i+1] || pixels[i+2]!==base[i+2]) {
            changed++;if(Math.abs(2*x/canvas.width-1)<Math.tan(7.5*Math.PI/180)-.008 && y>canvas.height*.48)protectedPixels++;
          }
        }
        const error=r.gl.getError();
        result.clips.push({knife,handedness,scale,aspect,changed,protectedPixels,error});
        if(error || changed<1000 || protectedPixels)throw new Error('Viewmodel pixel audit: '+JSON.stringify(result.clips.at(-1)));
        const inspected=trailFrame(q,2.3,q.correctLabel,model);
        await r.prepareViewmodel(2.3,inspected.motion);
        r.render(inspected.camera,{time:2.3,motion:inspected.motion,sunHeading:q.camera.heading});
        if(r.gl.getError())throw new Error('Inspect GL error');
      }
    }
    r.viewmodel?.dispose();r.gl.getExtension('WEBGL_lose_context')?.loseContext();
    for(const format of ['reels','post']) {
      const c=new ExportComposer(q,model,{format,appearance:{knife:'classic',handedness:'right'},easterEgg:null});
      c.animated=true;const texts=[],fill=c.ctx.fillText.bind(c.ctx);
      c.ctx.fillText=(...args)=>{texts.push(args[0]);fill(...args);};
      await c.drawFrameReady(4.5);
      const question={image:c.canvas.toDataURL(),texts:[...texts]};
      texts.length=0;await c.drawFrameReady(13,{reveal:true});
      const answer={image:c.canvas.toDataURL(),texts:[...texts]};
      await c.drawFrameReady(14.95,{reveal:true});
      if(JSON.stringify(trailFrame(q,14.95,q.correctLabel,model).camera)!==JSON.stringify(trailFrame(q,12,q.correctLabel,model).camera))
        throw new Error('Reveal moved the endpoint');
      result.exports.push({format,question,answer});
      if(format==='post') {
        const clip=await encodeCanvasVideo(c.canvas,t=>c.drawFrameReady(t),{duration:.5,fps:30});
        if(clip.blob.size<1000)throw new Error('Empty encoded trail video');
        result.video={bytes:clip.blob.size,type:clip.blob.type,extension:clip.extension,h264:clip.h264};
      } else {
        await c.drawFrameReady(4.5);
        const thumb=document.createElement('canvas');thumb.width=540;thumb.height=960;
        thumb.getContext('2d').drawImage(c.canvas,0,0,540,960);
        result.preview=thumb.toDataURL('image/jpeg',.72).split(',')[1];
      }
      if(c.renderer.gl.getError())throw new Error('Export GL error');
      c.dispose();
    }
    return result;
  },plain);
  for(const e of audit.exports) {
    assert.ok(e.question.texts.includes('WHICH TRAIL?'));
    assert.ok(e.question.texts.includes('BUNNY HOP · READ THE MOVING TERRAIN'));
    assert.ok(!e.question.texts.some(t=>t.startsWith('Answer:')));
    assert.ok(e.answer.texts.includes('Answer: '+original.correctLabel));
    if(out)for(const stage of ['question','answer'])
      await writeFile(join(out,'trail-export-'+e.format+'-'+stage+'.png'),Buffer.from(e[stage].image.split(',')[1],'base64'));
  }
  console.log('WebGL pixel audit: '+JSON.stringify(audit.clips));
  console.log('Encoded trail clip: '+JSON.stringify(audit.video));
  if(process.env.PRINT_PREVIEW==='1')console.log('TRAIL_PREVIEW_JPEG='+audit.preview);
  await page.locator('#mode').selectOption('friend');
  await ready(page,'WHERE IS YOUR FRIEND?');
  assert.equal(await page.locator('#trail-tools').isVisible(),false);
  assert.equal(await page.locator('#friend-tools').isVisible(),true);
  await page.locator('#friend-zoom').click();
  assert.equal(await page.locator('#friend-zoom').getAttribute('aria-pressed'),'true');
  await page.locator('#mode').selectOption('grid');await ready(page,'4 × 4 GRID');
  assert.equal(await page.locator('#grid-answer').isVisible(),true);
  assert.equal(await page.locator('#friend-tools').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('Trail browser checks passed: versioned worker, playback, inspect, decoded clips, colours, segment selection, timed comparisons, mobile touch, PNG/video export and mode switching.');
} catch(error) {
  console.error('Trail browser check failed:',error?.stack || error);
  console.log('Browser page errors: '+JSON.stringify(errors));
  if(process.env.PRINT_PREVIEW==='1') {
    const preview=await page.locator('.card').screenshot({type:'jpeg',quality:60}).catch(()=>null);
    if(preview)console.log('TRAIL_FAILURE_JPEG='+preview.toString('base64'));
  }
  if(out)await page.screenshot({path:join(out,'trail-failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await browser.close();server.close();
}
