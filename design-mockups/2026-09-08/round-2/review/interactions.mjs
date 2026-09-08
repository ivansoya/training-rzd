import {chromium} from '../../review/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const base='http://127.0.0.1:8777/round-2/', checks=[],errors=[],responsive=[],coordinates=[];
page.on('pageerror',e=>errors.push(e.message));
function check(name,ok,detail){checks.push({name,ok,detail});console.log(ok?'PASS':'FAIL',name,detail??'')}
async function go(screen,extra=''){await page.goto(base+(screen==='editor'?'editor':'screen')+'.html?screen='+screen+'&style=studio&palette=graphite'+extra)}
await go('projects');
await page.locator('[data-action="create-project"]').click();
await page.locator('[name="name"]').fill('Проверка макета');
await page.locator('#modal-form button[type="submit"]').click();
check('Create project locally',await page.locator('#screen-body').textContent().then(x=>x.includes('Проверка макета')));
await page.locator('#search').fill('не существует');
check('Project filter visually hides results',await page.locator('[data-search-row]:visible').count()===0);
await go('dataset');
await page.locator('#split-filter').selectOption('val');
check('Split filter changes gallery',await page.locator('.frame-card:visible').count()===1);
await page.locator('#unlabeled').check();
check('Unlabeled filter empty state',await page.locator('.frame-card:visible').count()===0);
await go('classes');
await page.locator('[data-action="create-class"]').click();
await page.locator('[name="name"]').fill('prototype-test');
await page.locator('#modal-form button[type="submit"]').click();
check('Create class locally',(await page.locator('#screen-body').textContent()).includes('prototype-test'));
await page.locator('#state-select').selectOption('readonly');
check('Readonly disables class edits',await page.locator('[data-action="create-class"]').isDisabled());
await page.locator('#state-select').selectOption('error');
await page.locator('[data-action="restore-state"]').click();
check('Retry restores screen',await page.locator('[data-action="create-class"]').isVisible());
await go('import');
await page.locator('[data-action="import-next"]').click();
await page.locator('[data-action="skipped-files"]').click();
check('Skipped archive files dialog',await page.locator('#dialog').isVisible());
await page.locator('#dialog-close').click();
await page.locator('[data-action="import-next"]').click();
check('Import class mapping',await page.locator('[name="class_name"]').count()===4);
await go('wizard');
for(let i=0;i<4;i++)await page.locator('[data-action="wizard-next"]').click();
check('Wizard reaches review',await page.locator('[data-action="build-set"]').isVisible());
await go('graph');
await page.locator('[data-node="1"]').click();
const node=page.locator('[data-node="1"]'), box=await node.boundingBox();
await page.mouse.move(box.x+60,box.y+30);await page.mouse.down();await page.mouse.move(box.x+90,box.y+65,{steps:5});await page.mouse.up();
const moved=await node.boundingBox();
check('Graph drag',moved.x>box.x+10&&moved.y>box.y+10);
await page.locator('#graph-version').selectOption({index:1});
check('Graph historical version locks controls',await page.locator('[data-action="save-graph"]').isDisabled()&&await page.locator('#node-inspector input').first().isDisabled());
await go('run');
const tab=page.locator('[data-tab]');for(let i=0;i<await tab.count();i++){await tab.nth(i).click();check('Run tab '+i,(await page.locator('#screen-body').textContent()).length>100)}
await go('overview');
const {screens,styles,palettes}=await page.evaluate(()=>DesignLab);
for(const size of [{width:1366,height:768},{width:430,height:932}]){
 await page.setViewportSize(size);
 for(const style of styles){
  for(const screen of screens.filter(s=>size.width>1000||['projects','overview','dataset','graph','run','editor'].includes(s.id))){
   await page.goto(base+(screen.id==='editor'?'editor':'screen')+'.html?screen='+screen.id+'&style='+style.id+'&palette=graphite&clean=1');
   await page.waitForTimeout(35);
   responsive.push({size:size.width,style:style.id,screen:screen.id,...await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,broken:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length}))});
  }
 }
 console.log('Responsive',size.width,'complete');
}
await page.setViewportSize({width:1440,height:960});
await go('editor');
for(const style of styles){
 await page.locator('#ed-style').selectOption(style.id);
 for(const palette of palettes){
  await page.locator('#ed-palette').selectOption(palette.id);
  await page.waitForTimeout(35);
  for(const mode of ['fit','zoom','pan']){
   if(mode==='fit')await page.locator('#fit').click();
   if(mode==='zoom')await page.locator('#zoom-in').click();
   if(mode==='pan'){const b=await page.locator('#stage').boundingBox();await page.mouse.move(b.x+40,b.y+50);await page.mouse.down();await page.mouse.move(b.x+75,b.y+70,{steps:3});await page.mouse.up()}
   const c=await page.evaluate(()=>{
    const media=document.querySelector('#media-frame').getBoundingClientRect(),canvas=document.querySelector('#frame-canvas').getBoundingClientRect(),svg=document.querySelector('#annotation-layer').getBoundingClientRect(),outline=document.querySelector('.box-outline').getBoundingClientRect();
    const b=visibleShapes()[0];
    return {error:Math.max(Math.abs(outline.x-(media.x+b.x*media.width)),Math.abs(outline.y-(media.y+b.y*media.height)),Math.abs(outline.width-b.w*media.width),Math.abs(outline.height-b.h*media.height)),aspectError:Math.abs(media.width/media.height-1920/1400),canvasError:Math.max(Math.abs(media.x-canvas.x),Math.abs(media.y-canvas.y),Math.abs(media.width-canvas.width),Math.abs(media.height-canvas.height)),sibling:document.querySelector('#annotation-layer').parentElement===document.querySelector('#media-frame').parentElement};
   });
   coordinates.push({style:style.id,palette:palette.id,mode,...c});
  }
 }
 console.log('Coordinate checks',style.id,'complete');
}
check('Responsive layouts',responsive.every(r=>r.overflow<=1&&r.broken===0),responsive.filter(r=>r.overflow>1||r.broken));
check('Canvas coordinates across all current styles × palettes × 3 modes',coordinates.every(c=>c.error<.1&&c.aspectError<.001&&c.canvasError<.1&&c.sibling),{maxError:Math.max(...coordinates.map(c=>c.error)),maxCanvasError:Math.max(...coordinates.map(c=>c.canvasError))});
for(const name of ['index','palettes','screens']){
 await page.goto(base+name+'.html'+(name==='screens'?'':'?view=sheet'));
 await page.screenshot({path:path.join(root,'previews',name+'-sheet.png'),fullPage:true});
 check('Catalog '+name,await page.evaluate(()=>![...document.images].some(i=>!i.naturalWidth)));
}
for(const [style,palette,screen] of [['orbit','graphite','overview'],['terminal','red','run'],['archive','slate','projects'],['studio','red','editor']]){
 await page.goto(base+(screen==='editor'?'editor':'screen')+'.html?screen='+screen+'&style='+style+'&palette='+palette+'&clean=1');
 await page.waitForTimeout(100);
 await page.screenshot({path:path.join(root,'previews','color-'+style+'.png')});
}
check('No JavaScript errors',errors.length===0,errors);
await writeFile(path.join(root,'review','interaction-report.json'),JSON.stringify({checks,errors,responsive,coordinates},null,2));
await browser.close();
if(checks.some(c=>!c.ok))process.exitCode=1;

