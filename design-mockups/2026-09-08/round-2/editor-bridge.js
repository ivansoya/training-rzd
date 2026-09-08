// Only restyle the standalone mockup; never attach styles to production BoxCanvas.
const edLab=DesignLab,edQuery=new URLSearchParams(location.search);
let edStyle=edLab.styles.find(s=>s.id===edQuery.get('style'))||edLab.styles[0];
let edPalette=edLab.palettes.find(p=>p.id===edQuery.get('palette'))||edLab.palettes.find(p=>p.id===edStyle.palette);
function applyEditorSkin(){edLab.apply(edPalette);document.body.dataset.style=edStyle.id;const root=document.documentElement;root.dataset.palette=edPalette.id;for(const [name,value] of Object.entries({'border':edPalette.line,'selected':edPalette.accent+'18','stage':edPalette.bg,'success':edPalette.accent2,'danger':'#FFB8B8','error-bg':'#402A30','on':edPalette.on}))root.style.setProperty('--'+name,value);document.title=`Редактор A / ${edStyle.name} / макет`}
applyEditorSkin();
const oldState=document.getElementById('state'),oldClean=document.getElementById('clean-view');
const edBar=document.querySelector('.review-bar');
edBar.innerHTML=`<a href="index.html">← Направления</a><label>Стиль<select id="ed-style">${edLab.styles.map(s=>`<option value="${s.id}" ${s.id===edStyle.id?'selected':''}>${s.name}</option>`).join('')}</select></label><label>Палитра<select id="ed-palette">${edLab.palettes.map(p=>`<option value="${p.id}" ${p.id===edPalette.id?'selected':''}>${p.name}</option>`).join('')}</select></label><label>Экран<select id="ed-screen">${edLab.screens.map(s=>`<option value="${s.id}" ${s.id==='editor'?'selected':''}>${s.name}</option>`).join('')}</select></label><label id="ed-state-slot">Состояние </label><span class="review-note muted">Компоновка A</span>`;
document.getElementById('ed-state-slot').append(oldState);edBar.append(oldClean);
function edUpdate(){applyEditorSkin();const u=new URL(location.href);u.searchParams.set('style',edStyle.id);u.searchParams.set('palette',edPalette.id);try{history.replaceState(null,'',u)}catch{}renderShapes();requestAnimationFrame(fitMedia);document.querySelector('.app-head>a:last-child').href=edLab.url('task',edStyle.id,edPalette.id)}
document.getElementById('ed-style').onchange=e=>{edStyle=edLab.styles.find(s=>s.id===e.target.value);edUpdate()};document.getElementById('ed-palette').onchange=e=>{edPalette=edLab.palettes.find(p=>p.id===e.target.value);edUpdate()};document.getElementById('ed-screen').onchange=e=>location.href=edLab.url(e.target.value,edStyle.id,edPalette.id);
document.querySelector('.app-head .brand').innerHTML='<span class="wordmark2">frame</span>';
document.querySelector('.app-head .crumb small').textContent='Варан / Работа захвата';document.querySelector('.app-head .crumb b').textContent='Разметка видео';
document.querySelector('.app-head>a:last-child').textContent='К таске ↗';document.querySelector('#help-dialog a').href='screens.html';document.querySelector('#help-dialog a').textContent='Все экраны и функции ↗';
if(edQuery.get('clean')==='1')document.body.classList.add('clean-view');edUpdate();
