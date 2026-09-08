import {chromium} from 'playwright';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir(path.join(root,'previews'),{recursive:true});
for(const file of ['index','palettes','audit']){await page.goto(pathToFileURL(path.join(root,file+'.html')).href);await page.waitForTimeout(150);await page.screenshot({path:path.join(root,'previews',file+'.png'),fullPage:true})}
const results=[];
for(const size of [{width:1440,height:900},{width:1366,height:768},{width:1920,height:1080},{width:390,height:844}]){
 await page.setViewportSize(size);
 for(const layout of ['a','b','c']){
  await page.goto(pathToFileURL(path.join(root,'editor.html')).href+`?layout=${layout}&palette=graphite`);
  await page.waitForFunction(()=>document.querySelector('#frame-canvas')?.width===1920&&document.querySelectorAll('[data-shape]').length===2);
  await page.waitForTimeout(150);
  const geometry=await page.evaluate(()=>{const media=document.querySelector('#media-frame').getBoundingClientRect(),stage=document.querySelector('#stage').getBoundingClientRect(),box=document.querySelector('.box-outline');return {ratioError:Math.abs(media.width/media.height-1920/1400),xError:Math.abs(Number(box.getAttribute('x'))-(media.left-stage.left+.535*media.width)),yError:Math.abs(Number(box.getAttribute('y'))-(media.top-stage.top+.33*media.height)),pageOverflow:document.documentElement.scrollWidth>innerWidth,mediaWidth:Math.round(media.width),mediaHeight:Math.round(media.height)}});
  results.push({size,layout,...geometry});
  if(size.width===1440||size.width===1366)await page.screenshot({path:path.join(root,'previews',`${layout}-${size.width}.png`)});
  if(size.width===1440){await page.getByLabel('Приблизить',{exact:true}).click();const z=await page.evaluate(()=>{const m=document.querySelector('#media-frame').getBoundingClientRect(),s=document.querySelector('#stage').getBoundingClientRect(),b=document.querySelector('.box-outline');return Math.abs(Number(b.getAttribute('x'))-(m.left-s.left+.535*m.width))});if(z>.1)throw new Error('Zoom alignment');await page.getByLabel('Вписать кадр (0)',{exact:true}).click()}
 }
}
await page.setViewportSize({width:1440,height:900});
for(const palette of ['neutral','graphite','slate','paper','signal']){
 await page.goto(pathToFileURL(path.join(root,'editor.html')).href+`?layout=a&palette=${palette}`);
 await page.waitForTimeout(200);await page.screenshot({path:path.join(root,'previews',`palette-${palette}.png`)});
}
await page.locator('#state').selectOption('loading');
if(await page.getByRole('button',{name:'Бокс (B)',exact:true}).isEnabled())throw new Error('Loading allows edit');
await page.locator('#state').selectOption('error');await page.getByRole('button',{name:'Повторить',exact:true}).click();
if(await page.locator('#state').inputValue()!=='ready')throw new Error('Retry state');
await page.locator('#state').selectOption('readonly');
if(await page.locator('#interpolate').isEnabled())throw new Error('Readonly allows edits');
await page.locator('#state').selectOption('ready');
await page.getByRole('tab',{name:'Одиночные',exact:true}).click();
if(!await page.getByText('На кадре нет одиночных объектов.',{exact:false}).isVisible())throw new Error('Singles');
await page.getByRole('tab',{name:'Треки 2',exact:true}).click();
await page.locator('#class-search').fill('wood');
if(await page.locator('.class-option').count()!==1)throw new Error('Search');
await page.locator('#class-search').fill('');
await page.getByLabel('Номер кадра',{exact:true}).fill('319');await page.getByLabel('Номер кадра',{exact:true}).press('Tab');await page.locator('#add-key').click();
if(await page.locator('.key').count()!==10)throw new Error('Key insertion');
await page.locator('#help').click();if(!await page.locator('#help-dialog').isVisible())throw new Error('Help');await page.locator('#close-help').click();
await writeFile(path.join(root,'review','validation.json'),JSON.stringify({errors,geometry:results,checks:['Zoom alignment','Loading edit guard','Error retry','Readonly guard','Object tabs','Class search','Local key insertion','Help dialog']},null,2));
console.log(JSON.stringify({errors,geometry:results},null,2));
if(errors.length||results.some(r=>r.xError>.1||r.yError>.1||r.ratioError>.001||r.pageOverflow))process.exitCode=1;
await browser.close();
