import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:1040}});
for(const name of ['index','palettes']){await page.goto(`http://127.0.0.1:8777/${name}.html?view=sheet`);await page.waitForTimeout(200);await page.screenshot({path:path.join(root,'previews',name+'-sheet.png'),fullPage:true})}
await page.setViewportSize({width:1440,height:900});
await page.goto('http://127.0.0.1:8777/editor.html?layout=a&palette=graphite');
await page.getByRole('button',{name:'Чистый макет',exact:true}).click();
await page.waitForTimeout(4400);
await page.screenshot({path:path.join(root,'previews','recommended.png')});
const stage=await page.locator('#stage').boundingBox();
await page.mouse.move(stage.x+35,stage.y+40);await page.mouse.down();await page.mouse.move(stage.x+90,stage.y+67);await page.mouse.up();
const panResult=await page.evaluate(()=>{const r=document.querySelector('#media-frame').getBoundingClientRect(),s=document.querySelector('#stage').getBoundingClientRect(),b=document.querySelector('.box-outline');return {xError:Math.abs(Number(b.getAttribute('x'))-(r.left-s.left+.535*r.width)),yError:Math.abs(Number(b.getAttribute('y'))-(r.top-s.top+.33*r.height))}});
if(panResult.xError>.1||panResult.yError>.1)throw new Error('Pan alignment failed');
console.log('HTTP, clean view and pan alignment OK',panResult);
await browser.close();
