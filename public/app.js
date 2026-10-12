const goals=[
  [1,'No Poverty','#e5243b','⌂'],[2,'Zero Hunger','#dda63a','♨'],[3,'Good Health','#4c9f38','♥'],[4,'Quality Education','#c5192d','▰'],[5,'Gender Equality','#ff3a21','⚧'],[6,'Clean Water','#26bde2','◒'],[7,'Clean Energy','#fcc30b','☀'],[8,'Decent Work','#a21942','↗'],[9,'Industry & Innovation','#fd6925','⬡'],[10,'Reduced Inequalities','#dd1367','='],[11,'Sustainable Cities','#fd9d24','▦'],[12,'Responsible Consumption','#bf8b2e','∞'],[13,'Climate Action','#3f7e44','◎'],[14,'Life Below Water','#0a97d9','≈'],[15,'Life on Land','#56c02b','♧'],[16,'Peace & Justice','#00689d','⚖'],[17,'Partnerships','#19486a','◉']
];
const state={user:null,stamps:[],activities:[],recent:[],config:{googleAuth:false,demoMode:false},stream:null,detector:null,scanning:false};
const $=selector=>document.querySelector(selector);

async function api(url,options={}){const response=await fetch(url,{headers:{'Content-Type':'application/json'},...options});const data=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok)throw new Error(data?.error||'Request failed.');return data}
function goal(id){return goals[id-1]}
function escapeHtml(value=''){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}

function renderUser(){
  $('#accountName').textContent=state.user?.name||'Guest passport';$('#accountState').textContent=state.user?'Passport synced':'Sign in to save';
  const avatar=$('#avatar');avatar.innerHTML=state.user?.avatar_url?`<img src="${escapeHtml(state.user.avatar_url)}" alt="">`:escapeHtml((state.user?.name||'G').charAt(0).toUpperCase());
}
function renderPassport(pop=[]){
  const ids=state.stamps.map(item=>Number(item.sdg_id));
  $('#stampGrid').innerHTML=goals.map(g=>`<article class="stamp ${ids.includes(g[0])?'collected':''} ${pop.includes(g[0])?'pop':''}" style="--goal:${g[2]}" aria-label="Goal ${g[0]}: ${g[1]}${ids.includes(g[0])?', collected':', not collected'}"><span class="stamp-number">${String(g[0]).padStart(2,'0')}</span><span class="stamp-icon">${g[3]}</span><span class="stamp-name">${g[1]}</span><span class="stamp-lock">＋</span></article>`).join('');
  $('#stampCount').textContent=ids.length;$('#progressBar').style.width=`${ids.length/17*100}%`;
}
function renderActivities(){
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  $('#scheduleList').innerHTML=state.activities.map((activity,index)=>{const [year,month,day]=activity.event_date.slice(0,10).split('-').map(Number),dateLabel=`${String(day).padStart(2,'0')} ${months[month-1]}`;return `<article class="schedule-item"><div class="day-number">Day ${index+1}<b>${dateLabel}</b></div><div class="schedule-copy"><h3>${escapeHtml(activity.title)}</h3><p>${escapeHtml(activity.description)}</p></div><div class="schedule-meta"><p><b>${escapeHtml(activity.time_label)}</b></p><p>${escapeHtml(activity.location)}</p></div><div class="goal-pills">${activity.sdg_ids.map(id=>`<span class="goal-pill" title="Goal ${id}: ${goal(id)[1]}" style="background:${goal(id)[2]}">${String(id).padStart(2,'0')}</span>`).join('')}</div></article>`}).join('');
  const demoCodes=$('#demoCodes');
  demoCodes.hidden=!state.config.demoMode;
  demoCodes.innerHTML=state.config.demoMode?state.activities.map((_,index)=>`<button type="button" data-code="BEYOND-BORDERS-DAY-${index+1}">Day ${index+1} demo</button>`).join(''):'';
  demoCodes.querySelectorAll('[data-code]').forEach(button=>button.onclick=()=>redeem(button.dataset.code));
}
function renderRecent(){
  $('#recentList').innerHTML=state.recent.length?state.recent.map(item=>`<article class="recent-card"><div class="recent-mark">✓</div><div class="recent-copy"><h3>${escapeHtml(item.title)}</h3><p>${new Date(item.earned_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})} · ${escapeHtml(item.location)}</p></div><div class="recent-goals">${item.sdg_ids.map(id=>`<i title="Goal ${id}" style="background:${goal(id)[2]}"></i>`).join('')}</div></article>`).join(''):'<div class="empty-state">Your verified scans will appear here.</div>';
}
async function load(){
  try{const [config,activities,me]=await Promise.all([api('/api/config'),api('/api/activities'),api('/api/me')]);Object.assign(state,{config,activities,user:me.user,stamps:me.stamps,recent:me.recent});renderUser();renderPassport();renderActivities();renderRecent();$('#demoLogin').hidden=!config.demoMode;if(!config.googleAuth)$('#googleButton').style.display='none'}catch(error){toast('Could not connect',error.message)}
}

function toast(title,copy){$('#toastTitle').textContent=title;$('#toastCopy').textContent=copy;$('#toast').classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3400)}
function openDialog(dialog){dialog.showModal()}
function requireLogin(){if(state.user)return true;openDialog($('#loginModal'));return false}

async function redeem(code){
  if(!requireLogin())return;
  try{
    const result=await api('/api/stamps/redeem',{method:'POST',body:JSON.stringify({code})});stopCamera();$('#scannerModal').close();
    const fresh=await api('/api/me');state.stamps=fresh.stamps;state.recent=fresh.recent;renderPassport(result.newlyAdded);renderRecent();
    $('#successTitle').textContent=result.activity.title;$('#successCopy').textContent=result.newlyAdded.length?`${result.newlyAdded.length} new goal${result.newlyAdded.length===1?'':'s'} added to your passport.`:'Your passport already contained these goals.';
    $('#unlockedGrid').innerHTML=result.goals.map(id=>{const g=goal(id);return `<div class="mini-stamp" style="background:${g[2]}"><b>${String(id).padStart(2,'0')}</b><small>${g[1]}</small></div>`}).join('');openDialog($('#successModal'));
  }catch(error){toast('Code not collected',error.message)}
}

async function startCamera(){
  if(!requireLogin())return;
  if(!('BarcodeDetector' in window)){toast('Camera scanner unsupported','Enter the activity code below instead.');return}
  try{
    state.detector=new BarcodeDetector({formats:['qr_code']});state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});const camera=$('#camera');camera.querySelector('.camera-copy')?.remove();const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.srcObject=state.stream;camera.prepend(video);camera.classList.add('scanning');state.scanning=true;scanFrame(video);
  }catch(error){toast('Camera unavailable','Allow camera access or enter the code manually.')}
}
async function scanFrame(video){
  if(!state.scanning)return;
  try{const codes=await state.detector.detect(video);if(codes[0]?.rawValue){state.scanning=false;await redeem(codes[0].rawValue);return}}catch(_error){}
  requestAnimationFrame(()=>scanFrame(video));
}
function stopCamera(){state.scanning=false;state.stream?.getTracks().forEach(track=>track.stop());state.stream=null;const video=$('#camera video');if(video)video.remove();$('#camera').classList.remove('scanning');if(!$('#camera .camera-copy'))$('#camera').insertAdjacentHTML('beforeend','<div class="camera-copy"><span>⌗</span><b>Camera is off</b><small>Tap below to begin</small></div>')}

function roundedRect(ctx,x,y,w,h,r,fill){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill()}
function wrapText(ctx,text,x,y,maxWidth,lineHeight,maxLines=3){const words=text.split(' ');let line='',lines=[];for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word}else line=test}if(line)lines.push(line);lines.slice(0,maxLines).forEach((item,i)=>ctx.fillText(item,x,y+i*lineHeight))}
async function downloadStory(){
  const canvas=$('#storyCanvas'),ctx=canvas.getContext('2d'),owned=new Set(state.stamps.map(s=>Number(s.sdg_id)));ctx.clearRect(0,0,1080,1920);
  const grad=ctx.createLinearGradient(0,0,1080,1920);grad.addColorStop(0,'#123d35');grad.addColorStop(1,'#071f1b');ctx.fillStyle=grad;ctx.fillRect(0,0,1080,1920);
  ctx.fillStyle='rgba(216,242,74,.08)';ctx.beginPath();ctx.arc(960,90,380,0,Math.PI*2);ctx.fill();ctx.fillStyle='#bfe5d5';ctx.font='700 26px Arial';ctx.letterSpacing='4px';ctx.fillText('BEYOND BORDERS · 2026',70,95);
  ctx.fillStyle='#ffffff';ctx.font='900 86px Arial';ctx.fillText('My SDG',70,220);ctx.fillStyle='#d8f24a';ctx.fillText('Passport',70,305);
  const participantName=state.user?.name||'Impact Participant';ctx.fillStyle='#bfe5d5';ctx.font='700 16px Arial';ctx.fillText('PARTICIPANT',72,352);ctx.fillStyle='#ffffff';ctx.font=participantName.length>22?'700 28px Arial':'700 36px Arial';ctx.fillText(participantName,72,394);ctx.textAlign='right';ctx.fillStyle='#ffffff';ctx.font='900 64px Arial';ctx.fillText(`${owned.size}/17`,1010,275);ctx.fillStyle='#bfe5d5';ctx.font='700 20px Arial';ctx.fillText('GOALS COLLECTED',1010,315);ctx.textAlign='left';
  const cols=4,w=220,h=220,gap=22,startX=70,startY=440;goals.forEach((g,index)=>{const row=Math.floor(index/cols),col=index%cols,x=startX+col*(w+gap),y=startY+row*(h+gap),isOwned=owned.has(g[0]);roundedRect(ctx,x,y,w,h,26,isOwned?g[2]:'#173e38');ctx.fillStyle=isOwned?'#fff':'#67817a';ctx.font='900 52px Arial';ctx.fillText(String(g[0]).padStart(2,'0'),x+20,y+62);ctx.globalAlpha=isOwned?1:.35;ctx.font='700 36px Arial';ctx.textAlign='right';ctx.fillText(g[3],x+w-20,y+58);ctx.textAlign='left';ctx.font='800 20px Arial';wrapText(ctx,g[1].toUpperCase(),x+20,y+155,w-40,24,2);ctx.globalAlpha=1});
  roundedRect(ctx,70,1682,940,120,24,'#d8f24a');ctx.fillStyle='#123d35';ctx.font='900 30px Arial';ctx.fillText('Beyond Borders',105,1734);ctx.font='600 20px Arial';ctx.fillText('9 - 15 February 2026 · Assumption University',105,1771);ctx.textAlign='right';ctx.font='900 28px Arial';ctx.fillText('AIESEC',970,1750);ctx.textAlign='center';ctx.fillStyle='#78978f';ctx.font='500 17px Arial';ctx.fillText('Created with love by Khine Khant',540,1862);ctx.textAlign='left';
  canvas.toBlob(blob=>{if(!blob)return toast('Download failed','Please try again.');const url=URL.createObjectURL(blob),link=document.createElement('a'),participantSlug=participantName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'participant';link.href=url;link.download=`beyond-borders-${participantSlug}-passport.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Story downloaded',`${participantName}'s 1080 × 1920 passport PNG is ready.`)},'image/png');
}

$('#openScanner').onclick=()=>requireLogin()&&openDialog($('#scannerModal'));$('#startCamera').onclick=startCamera;$('#downloadPassport').onclick=downloadStory;$('#downloadTop').onclick=downloadStory;$('#accountButton').onclick=()=>state.user?toast('Passport synced',state.user.email||'You are signed in.'):openDialog($('#loginModal'));
$('#codeForm').onsubmit=event=>{event.preventDefault();redeem($('#codeInput').value)};
$('#demoLogin').onclick=async()=>{try{const result=await api('/auth/demo',{method:'POST',body:'{}'});state.user=result.user;$('#loginModal').close();renderUser();const me=await api('/api/me');state.stamps=me.stamps;state.recent=me.recent;renderPassport();renderRecent();toast('Demo passport ready','Try any of the day codes in the scanner.')}catch(error){toast('Sign-in failed',error.message)}};
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()}));$('#scannerModal').addEventListener('close',stopCamera);
load();
