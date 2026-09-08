/* Shared catalogue for the second design review. All palettes are dark. */
window.DesignLab={
styles:[
{id:'studio',name:'Студия',tag:'Спокойный рабочий инструмент',text:'Боковая навигация, ясные заголовки, свободные интервалы и компактные свойства. Работа с данными без визуального шума.',font:'Segoe UI / Arial',geometry:'Радиусы 8–12 px',density:'Средняя плотность',palette:'graphite'},
{id:'terminal',name:'Терминал',tag:'Инженерная точность',text:'Горизонтальная навигация, прямые углы, моноширинные подписи и плотные регистры. Больше информации в одном экране.',font:'Consolas / Segoe UI',geometry:'Прямые углы',density:'Высокая плотность',palette:'red'},
{id:'orbit',name:'Орбита',tag:'Мягкая цифровая среда',text:'Короткая навигационная рейка, округлые панели, крупные числа и сегментные переключатели. Два акцента с разными ролями.',font:'Trebuchet MS / Segoe UI',geometry:'Радиусы 16–24 px',density:'Свободная плотность',palette:'graphite'},
{id:'archive',name:'Атлас',tag:'Редакционный характер',text:'Типографика как основа: выразительные заголовки, открытые списки и минимум контейнеров. Интерфейс ближе к профессиональному каталогу.',font:'Georgia / Segoe UI',geometry:'Тонкие линии, без карточной рамки',density:'Контраст плотности',palette:'slate'}
],
palettes:[
{id:'graphite',name:'Графит / мята',group:'Сдержанные',bg:'#171C22',panel:'#242C35',raised:'#303B46',text:'#EDF3F6',muted:'#B3C1CB',line:'#465767',control:'#7A8D9E',accent:'#A6DAC8',accent2:'#B4BAFF',on:'#152921'},
{id:'slate',name:'Сланец / ледяной',group:'Сдержанные',bg:'#202936',panel:'#2D3B4C',raised:'#3A4B60',text:'#F0F4FA',muted:'#C4CFDC',line:'#5A6C83',control:'#93A5BC',accent:'#B4D2F4',accent2:'#D0C5E8',on:'#172C47'},
{id:'red',name:'Обсидиан / красный',group:'Новая',bg:'#191B20',panel:'#272B32',raised:'#353A43',text:'#F4F0F1',muted:'#C7C1C6',line:'#565A65',control:'#969BA8',accent:'#EF6B73',accent2:'#C5CDD8',on:'#261518'}
],
screens:[
{id:'projects',name:'Проекты',group:'Рабочая среда',note:'Список, создание, поиск и доступ к проекту',source:'ProjectsPage'},
{id:'overview',name:'Обзор проекта',group:'Данные',note:'Сводка, классы, все кадры и переходы к работе',source:'ProjectOverview'},
{id:'tasks',name:'Таски',group:'Разметка',note:'Список заданий, состояние и создание',source:'ProjectTasks'},
{id:'task',name:'Таска и видео',group:'Разметка',note:'Состояние задачи, исходники, видео и разметка',source:'TaskPage'},
{id:'datasets',name:'Датасеты',group:'Данные',note:'Список датасетов, импорт и открытие',source:'ProjectDatasets'},
{id:'dataset',name:'Галерея кадров',group:'Данные',note:'Поиск, фильтры, split, размер плиток и просмотр',source:'DatasetPage'},
{id:'editor',name:'Редактор A',group:'Разметка',note:'Видео, канвасы, треки и правый инспектор',source:'VideoAnnotator / BoxCanvas'},
{id:'classes',name:'Классы',group:'Данные',note:'Поиск, цвет, группы и редактирование названий',source:'ProjectClasses'},
{id:'members',name:'Участники',group:'Рабочая среда',note:'Роли, присутствие и приглашения',source:'ProjectMembers'},
{id:'import',name:'Импорт',group:'Данные',note:'Архив, проверка состава, сопоставление классов',source:'ImportWizard'},
{id:'augments',name:'Библиотека графов',group:'Подготовка',note:'Личные графы, версии, создание и переход к редактору',source:'AugGraphList / ProjectAug'},
{id:'graph',name:'Редактор графа',group:'Подготовка',note:'Каталог узлов, граф, свойства и предпросмотр',source:'AugGraphEditor'},
{id:'training',name:'Наборы и обучения',group:'Обучение',note:'Наборы, запуски, очередь и старт обучения',source:'TrainingHome'},
{id:'trainset',name:'Обучающий набор',group:'Обучение',note:'Состав, split, классы и образцы',source:'TrainSetView'},
{id:'wizard',name:'Сборка набора',group:'Подготовка',note:'Источники, выбор, деление, аугментации и проверка',source:'TrainSetWizard'},
{id:'run',name:'Результаты обучения',group:'Обучение',note:'Метрики, loss, классы, матрица ошибок и веса',source:'TrainRunPage'},
{id:'hardware',name:'Оборудование',group:'Рабочая среда',note:'GPU, память, ограничения и очередь',source:'HardwarePage'},
{id:'account',name:'Кабинет',group:'Рабочая среда',note:'Профиль, пароль, друзья и приглашения',source:'AccountPage'},
{id:'login',name:'Вход',group:'Рабочая среда',note:'Вход, регистрация и подтверждение почты',source:'AuthPages / ConfirmPage'}
],
apply(p){for(const k of ['bg','panel','raised','text','muted','line','control','accent','accent2','on'])document.documentElement.style.setProperty('--'+k,p[k]);document.documentElement.style.setProperty('--accent-soft',p.accent+'18');document.documentElement.style.setProperty('--accent2-soft',p.accent2+'18');document.documentElement.style.colorScheme='dark'},
url(screen,style,palette){return `${screen==='editor'?'editor':'screen'}.html?screen=${screen}&style=${style}&palette=${palette}`},
lum(hex){return hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0)},
ratio(a,b){const x=this.lum(a),y=this.lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
};
