import {chromium} from '../../review/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:960}});
const errors=[],results=[];let active='';page.on('pageerror',e=>errors.push({active,error:e.message}));
const base='http://127.0.0.1:8777/round-2/';
await page.goto(base+'screen.html?screen=overview');
const {screens,styles,palettes}=await page.evaluate(()=>DesignLab);
for(const style of styles){
 for(const screen of screens){
  active=style.id+'/'+screen.id;
  const target=screen.id==='editor'?'editor':'screen';
  await page.goto(base+target+'.html?screen='+screen.id+'&style='+style.id+'&palette=graphite&clean=1');
  await page.waitForTimeout(90);
  const check=await page.evaluate(()=>({h1:document.querySelector('h1')?.textContent||document.querySelector('.crumb b')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth+1,broken:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length,body:document.body.textContent.length}));
  results.push({active,...check});
  if(['overview','projects','dataset','graph','run','editor','task'].includes(screen.id))await page.screenshot({path:path.join(root,'previews',style.id+'-'+screen.id+'.png')});
  if(screen.id==='overview')await page.screenshot({path:path.join(root,'previews','style-'+style.id+'.png')});
 }
 console.log('Reviewed',style.id);
}
const contrasts=palettes.map(p=>({palette:p.id}));
await page.goto(base+'screen.html?screen=overview');
const contrastResults=await page.evaluate(()=>DesignLab.palettes.map(p=>({id:p.id,text:DesignLab.ratio(p.text,p.panel),muted:DesignLab.ratio(p.muted,p.panel),button:DesignLab.ratio(p.on,p.accent),secondary:DesignLab.ratio(p.accent2,p.panel),dark:DesignLab.lum(p.bg)<.04})));
await writeFile(path.join(root,'review','visual-report.json'),JSON.stringify({errors,results,contrastResults},null,2));
console.log(JSON.stringify({errors,issues:results.filter(r=>r.overflow||r.broken||r.body<200),contrasts:contrastResults.map(r=>({id:r.id,min:Math.min(r.text,r.muted,r.button,r.secondary).toFixed(2),dark:r.dark}))},null,2));
await browser.close();
if(errors.length||results.some(r=>r.overflow||r.broken||r.body<200)||contrastResults.some(r=>!r.dark||Math.min(r.text,r.muted,r.button,r.secondary)<4.5))process.exitCode=1;
