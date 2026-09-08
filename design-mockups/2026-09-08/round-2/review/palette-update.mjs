import {chromium} from '../../review/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:8777/round-2/';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const errors=[],checks=[],coordinates=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'palettes.html');
const lab=await page.evaluate(()=>DesignLab);
lab.url=(screen,style,palette)=>(screen==='editor'?'editor':'screen')+'.html?screen='+screen+'&style='+style+'&palette='+palette;
if(lab.palettes.map(p=>p.id).join(',')!=='graphite,slate,red')throw Error('Unexpected palette list');
const contrasts=await page.evaluate(()=>DesignLab.palettes.map(p=>({id:p.id,accent:DesignLab.ratio(p.accent,p.panel),button:DesignLab.ratio(p.on,p.accent),text:DesignLab.ratio(p.text,p.panel),muted:DesignLab.ratio(p.muted,p.panel)})));
for(const style of lab.styles){
 for(const palette of lab.palettes){
  for(const screen of lab.screens){
   await page.goto(base+lab.url(screen.id,style.id,palette.id));
   const result=await page.evaluate(()=>({options:document.querySelector('#palette-select,#ed-palette').options.length,palette:document.querySelector('#palette-select,#ed-palette').value,overflow:document.documentElement.scrollWidth>innerWidth+1}));
   checks.push({style:style.id,screen:screen.id,palette:palette.id,...result});
   if(screen.id==='editor'){
    await page.waitForTimeout(40);
    for(const mode of ['fit','zoom','pan']){
     if(mode==='zoom')await page.locator('#zoom-in').click();
     if(mode==='pan'){const b=await page.locator('#stage').boundingBox();await page.mouse.move(b.x+30,b.y+40);await page.mouse.down();await page.mouse.move(b.x+60,b.y+60,{steps:2});await page.mouse.up()}
     coordinates.push({style:style.id,palette:palette.id,mode,...await page.evaluate(()=>{
      const r=document.querySelector('#media-frame').getBoundingClientRect(),c=document.querySelector('#frame-canvas').getBoundingClientRect(),b=visibleShapes()[0],a=document.querySelector('.box-outline').getBoundingClientRect();
      return {error:Math.max(Math.abs(a.x-r.x-b.x*r.width),Math.abs(a.y-r.y-b.y*r.height),Math.abs(a.width-b.w*r.width),Math.abs(a.height-b.h*r.height)),canvasError:Math.max(Math.abs(c.x-r.x),Math.abs(c.y-r.y),Math.abs(c.width-r.width),Math.abs(c.height-r.height))};
     })});
    }
   }
  }
 }
 console.log('Verified',style.id);
}
for(const [file,style,palette,screen] of [['red-overview','studio','red','overview'],['red-editor','studio','red','editor'],['color-studio','studio','red','editor'],['color-terminal','terminal','red','run'],['color-orbit','orbit','graphite','overview'],['color-archive','archive','slate','projects']]){
 await page.goto(base+lab.url(screen,style,palette)+'&clean=1');await page.waitForTimeout(70);
 await page.screenshot({path:new URL('../previews/'+file+'.png',import.meta.url).pathname.slice(1)});
}
for(const name of ['index','palettes','screens']){
 await page.goto(base+name+'.html'+(name==='screens'?'':'?view=sheet'));
 await page.screenshot({path:new URL('../previews/'+name+'-sheet.png',import.meta.url).pathname.slice(1),fullPage:true});
}
await page.goto(base+'screen.html?screen=overview&style=terminal&palette=acid');
const fallback=await page.locator('#palette-select').inputValue();
const report={errors,checks,coordinates,contrasts,oldPaletteFallback:fallback};
await writeFile(new URL('palette-update-report.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({errors,count:checks.length,issues:checks.filter(c=>c.options!==3||c.overflow),contrasts,coordinateMax:Math.max(...coordinates.map(c=>c.error)),fallback},null,2));
await browser.close();
if(errors.length||checks.some(c=>c.options!==3||c.overflow)||coordinates.some(c=>c.error>.1||c.canvasError>.1)||contrasts.some(c=>Math.min(c.accent,c.button,c.text,c.muted)<4.5)||fallback!=='red')process.exitCode=1;
