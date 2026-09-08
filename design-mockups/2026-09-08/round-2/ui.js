const lab=window.DesignLab, query=new URLSearchParams(location.search);
let styleId=lab.styles.some(s=>s.id===query.get('style'))?query.get('style'):'studio';
let paletteId=lab.palettes.some(p=>p.id===query.get('palette'))?query.get('palette'):lab.styles.find(s=>s.id===styleId).palette;
let screenId=lab.screens.some(s=>s.id===query.get('screen'))?query.get('screen'):'overview';
let displayState='ready';
const demo={tab:'',importStep:0,wizardStep:0,auth:'login',classRows:[['gorynych',1000,'Рабочие органы','#72BCFF'],['shredder',996,'Рабочие органы','#B7B7F0'],['wood-sleeper',993,'Путевое хозяйство','#FFCC80'],['sleeper',957,'Путевое хозяйство','#8BDCBA'],['rail-grab',937,'Рабочие органы','#72BCFF'],['big-grab-closed',861,'Рабочие органы','#E5ADD9'],['narrow-grab-closed',860,'Рабочие органы','#FFCC80']],extraProjects:[],node:'1',graphNodes:[{id:'0',title:'Входные кадры',kind:'Источник',x:28,y:28},{id:'1',title:'Яркость и контраст',kind:'Цвет',x:238,y:170},{id:'2',title:'Готовый набор',kind:'Выход',x:70,y:337}]};
const h=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const route=(screen,extra='')=>lab.url(screen,styleId,paletteId)+extra;
const link=(screen,text,cls='button')=>`<a class="${cls}" href="${route(screen)}">${text}</a>`;
const action=(name,text,cls='')=>`<button type="button" class="${cls}" data-action="${name}">${text}</button>`;
const badge=(text,cls='')=>`<span class="tag ${cls}">${text}</span>`;
const table=(headers,rows,cls='')=>`<div class="table-panel ${cls}"><div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr data-search-row>${row.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
const panel=(title,body,more='')=>`<section class="panel"><div class="panel-head"><h2>${title}</h2>${more}</div>${body}</section>`;
const statrow=rows=>`<section class="stats" aria-label="Показатели">${rows.map(([title,value,note])=>`<div class="stat"><small>${title}</small><strong>${value}</strong><em>${note}</em></div>`).join('')}</section>`;
const field=(label,control,small='',wide=false)=>`<label class="form-field ${wide?'wide':''}"><span>${label}</span>${control}${small?`<small>${small}</small>`:''}</label>`;
const input=(name,value='',type='text',more='')=>`<input name="${name}" type="${type}" value="${h(value)}" ${more}>`;
const select=(name,items)=>`<select name="${name}">${items.map(i=>`<option>${i}</option>`).join('')}</select>`;
const tabs=(items,active)=>`<div class="tabs" role="tablist">${items.map(([id,text])=>`<button role="tab" class="${active===id?'on':''}" aria-selected="${active===id}" data-tab="${id}">${text}</button>`).join('')}</div>`;
const search=(placeholder='Найти…')=>`<input id="search" type="search" placeholder="${placeholder}" aria-label="${placeholder}">`;
const kv=rows=>rows.map(([k,v])=>`<div class="kv"><span>${k}</span><strong>${v}</strong></div>`).join('');
const chart=(kind='quality',title='Качество по эпохам')=>{const paths=kind==='loss'?['M34 26 L57 41 L81 74 L108 80 L138 105 L169 112 L201 126 L233 132 L265 139 L297 144 L329 153 L361 149 L393 163 L425 166 L457 174 L489 173 L522 180 L558 183','M34 50 L57 71 L81 85 L108 102 L138 115 L169 126 L201 127 L233 140 L265 145 L297 151 L329 157 L361 160 L393 169 L425 168 L457 175 L489 180 L522 178 L558 186']:['M34 179 L57 166 L81 154 L108 126 L138 131 L169 105 L201 97 L233 90 L265 78 L297 79 L329 65 L361 61 L393 52 L425 54 L457 42 L489 39 L522 34 L558 31','M34 188 L57 180 L81 161 L108 148 L138 149 L169 123 L201 119 L233 105 L265 100 L297 97 L329 91 L361 83 L393 80 L425 75 L457 71 L489 66 L522 63 L558 58'];return `<div class="legend"><span><i></i>${kind==='loss'?'Train loss':'mAP@50'}</span><span class="alt"><i></i>${kind==='loss'?'Val loss':'mAP@50–95'}</span></div><svg class="chart" viewBox="0 0 590 220" role="img" aria-label="${title}. Демонстрационные значения.">${[35,80,125,170].map((y,i)=>`<line class="gridline" x1="34" x2="558" y1="${y}" y2="${y}"/><text x="0" y="${y+3}">${kind==='loss'?(2-i*.5).toFixed(1):(.9-i*.2).toFixed(1)}</text>`).join('')}${[0,20,40,60,80].map((n,i)=>`<text x="${34+i*128}" y="213">${n}</text>`).join('')}<path class="series" d="${paths[0]}"/><path class="series alt" d="${paths[1]}"/><text x="530" y="213">эпоха</text></svg>`};
const classbars=()=>demo.classRows.slice(0,5).map(([name,count,,color],i)=>`<div class="class-list-row"><span class="num muted">${i+1}</span><span>${name}</span><span class="bar"><i style="--value:${count/10}%"></i></span><span class="num">${count}</span></div>`).join('');
const gallery=(count=8)=>`<div class="gallery" id="gallery">${Array.from({length:count},(_,i)=>`<button class="frame-card" data-action="frame-${i}" data-search-row data-split="${i===6?'val':'train'}"><div class="thumb"><img src="assets/frame-${i%8}.jpg" alt="Кадр ${i+1}: работа захвата с деревянной шпалой" loading="eager"><span class="thumb-box"></span><span class="thumb-box alt"></span></div><div class="frame-info"><b>008_varan_${4882+i}</b><small>${i===6?'val':'train'} / 2 объекта</small></div></button>`).join('')}</div>`;
const taskRows=()=>[
['<b>Работа захвата</b><small>Камера 008 / 3 ролика</small>',badge('В работе','accent'),'Елена Морозова','284 / 750',link('task','Открыть','button')],
['<b>Путевой участок</b><small>Камера 012 / 186 кадров</small>',badge('На проверке','alt'),'Павел Лебедев','186 / 186',link('task','Открыть','button')],
['<b>Манипулятор: вечер</b><small>Камера 008 / 2 ролика</small>',badge('Новая'),'Не назначен','0 / 426',link('task','Открыть','button')],
['<b>Смена рабочего органа</b><small>Камера 004 / 318 кадров</small>',badge('Готова'),'Ирина Соколова','318 / 318',link('task','Открыть','button')]
];
const screenContent={};
