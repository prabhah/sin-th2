let meta=null, historyCursor=null, loading=false, refreshing=false, downloading=false;
const refreshIntervalMs=10000;
const records=[];
const $=id=>document.getElementById(id);
let statusTimer=null;
let currentReading=null;
const correctionDefaults={temperature:-2.6,humidity:-14.8};
const legacyCorrectionDefaults={temperature:-1.5,humidity:-16};
const correctionStorageKey='sin-th2-corrections-v2';
let corrections={...correctionDefaults};

function validCorrections(value){
  return Number.isFinite(value?.temperature)&&Number.isFinite(value?.humidity);
}

function readCorrectionCookie(){
  try{
    const prefix=correctionStorageKey+'=';
    const item=document.cookie.split('; ').find(part=>part.startsWith(prefix));
    return item?JSON.parse(decodeURIComponent(item.slice(prefix.length))):null;
  }catch{return null}
}

function loadCorrections(){
  let saved=null;
  try{saved=JSON.parse(localStorage.getItem(correctionStorageKey))}catch{}
  if(!validCorrections(saved)) saved=readCorrectionCookie();
  if(validCorrections(saved))return saved;

  // Preserve genuine legacy custom values, but migrate the previous defaults.
  let legacy=null;
  try{legacy=JSON.parse(localStorage.getItem('sin-th2-corrections'))}catch{}
  if(validCorrections(legacy)&&!(legacy.temperature===legacyCorrectionDefaults.temperature&&legacy.humidity===legacyCorrectionDefaults.humidity))return legacy;
  return {...correctionDefaults};
}

function persistCorrections(){
  const value=JSON.stringify(corrections);
  try{localStorage.setItem(correctionStorageKey,value)}catch{}
  try{document.cookie=`${correctionStorageKey}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`}catch{}
}

corrections=loadCorrections();

const correctedTemperature=value=>value+corrections.temperature;
const correctedHumidity=value=>value+corrections.humidity;
const signed=value=>`${value>=0?'+':''}${value.toFixed(1)}`;

function createRecordRow(record){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td>${record.index}</td><td>${record.time}</td><td>${correctedTemperature(record.temperature).toFixed(1)}</td><td>${correctedHumidity(record.humidity).toFixed(1)}</td>`;
  return tr;
}

function renderTable(){
  const body=$('rows');
  body.innerHTML='';
  for(const record of [...records].reverse()) body.appendChild(createRecordRow(record));
}

function renderCurrent(){
  if(!currentReading)return;
  $('temp').textContent=correctedTemperature(currentReading.temperature).toFixed(1)+' °C';
  $('hum').textContent=correctedHumidity(currentReading.humidity).toFixed(1)+' %';
}

function renderCorrectedData(){
  $('correctionSummary').textContent=`当前：温度 ${signed(corrections.temperature)} °C，湿度 ${signed(corrections.humidity)} %RH`;
  renderCurrent();
  renderTable();
  drawChart();
}

function renderCorrections(){
  $('tempCorrection').value=corrections.temperature;
  $('humCorrection').value=corrections.humidity;
  renderCorrectedData();
}

function previewCorrection(key, input, min, max){
  const value=Number(input.value);
  if(!Number.isFinite(value))return;
  corrections[key]=Math.max(min,Math.min(max,value));
  persistCorrections();
  renderCorrectedData();
}

function saveCorrections(){
  persistCorrections();
  renderCorrections();
  setStatus('修正值已保存并应用到当前读数、历史数据、曲线和 CSV。','success',true);
}

function setStatus(message, type='info', autoClear=false){
  clearTimeout(statusTimer);
  const el=$('status');
  el.textContent=message;
  el.className=message?type:'';
  if(message && autoClear) statusTimer=setTimeout(()=>setStatus(''),3000);
}

function setButtonLoading(id, busy, busyLabel){
  const button=$(id);
  button.classList.toggle('loading',busy);
  button.disabled=busy;
  button.setAttribute('aria-busy',String(busy));
  button.querySelector('.button-label').textContent=busy?busyLabel:button.dataset.defaultLabel;
}

function updateLoadButton(){
  const button=$('loadMore');
  if(loading) return;
  const complete=meta && historyCursor!==null && historyCursor<=0;
  button.disabled=Boolean(complete);
  button.querySelector('.button-label').textContent=complete?'更早的数据已全部加载':button.dataset.defaultLabel;
}

function updateDownloadButton(){
  if(downloading) return;
  $('download').disabled=!meta||meta.recordCount===0;
}

function setAutoRefresh(message, type){
  const el=$('autoRefresh');
  el.textContent=message;
  el.className=`auto-refresh ${type}`;
}

function resetHistory(message='设备中暂无历史记录'){
  records.length=0;
  historyCursor=null;
  $('rows').innerHTML='';
  $('loaded').textContent='尚未加载';
  $('sentinel').textContent=message;
  drawChart();
}

async function api(url, opts){
  const r=await fetch(url,opts);
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||r.statusText);
  return j;
}

async function refreshMeta(){
  meta=await api('/api/meta');
  $('model').textContent=meta.model;
  $('deviceTime').textContent=meta.deviceTime;
  $('interval').textContent=(meta.intervalSec/60)+' 分钟';
  $('count').textContent=meta.recordCount+' / '+meta.capacity;
  currentReading=await api('/api/current');
  renderCurrent();
}

async function loadMore({feedback=true}={}){
  if(loading) return;
  if(!meta){
    if(feedback) setStatus('设备信息尚未加载完成，请稍候。','info',true);
    return;
  }
  if(historyCursor===null) historyCursor=meta.recordCount;
  if(historyCursor<=0){
    if(feedback) setStatus('更早的历史数据已全部加载。','success',true);
    if(meta.recordCount===0) $('sentinel').textContent='设备中暂无历史记录';
    updateLoadButton();
    return;
  }
  loading=true;
  if(feedback){
    setButtonLoading('loadMore',true,'正在加载…');
    setStatus(`正在读取历史数据（${records.length} / ${meta.recordCount}）…`,'loading');
  }
  try{
    // Device protocol permits at most 60 records per 0x13 request.
    const count=Math.min(60,historyCursor);
    const start=historyCursor-count;
    const batch=await api(`/api/records?start=${start}&count=${count}`);
    records.unshift(...batch);
    for(const r of [...batch].reverse()) $('rows').appendChild(createRecordRow(r));
    historyCursor=start;
    $('loaded').textContent=`已加载 ${records.length} / ${meta.recordCount} 条`;
    drawChart();
    if(historyCursor<=0) $('sentinel').textContent='更早的历史记录已全部加载';
    else $('sentinel').textContent='向下滚动继续加载更早的数据';
    if(feedback) setStatus(`成功加载 ${batch.length} 条更早的历史数据。`,'success',true);
  }catch(e){
    if(feedback) setStatus(`加载失败：${e.message}`,'error');
    else throw e;
  }
  finally{
    loading=false;
    if(feedback) setButtonLoading('loadMore',false,'');
    updateLoadButton();
  }
}

function drawChart(){
  const c=$('chart'), dpr=window.devicePixelRatio||1, rect=c.getBoundingClientRect();
  c.width=Math.max(1,rect.width*dpr); c.height=Math.max(1,rect.height*dpr);
  const x=c.getContext('2d'); x.scale(dpr,dpr);
  const w=rect.width,h=rect.height,left=52,right=52,top=18,bottom=34;
  x.clearRect(0,0,w,h);
  x.font='12px sans-serif';
  if(!records.length){
    x.fillStyle='#8a9099';
    x.textAlign='center';
    x.fillText('暂无历史数据',w/2,h/2);
    return;
  }
  const temps=records.map(r=>correctedTemperature(r.temperature)), hums=records.map(r=>correctedHumidity(r.humidity));
  let tempLo=Math.min(...temps),tempHi=Math.max(...temps),humLo=Math.min(...hums),humHi=Math.max(...hums);
  if(tempLo===tempHi){tempLo-=1;tempHi+=1}
  if(humLo===humHi){humLo=Math.max(0,humLo-2);humHi=Math.min(100,humHi+2)}
  const plotW=w-left-right,plotH=h-top-bottom;
  const px=i=>records.length===1?left+plotW/2:left+plotW*i/(records.length-1);
  x.strokeStyle='#d8dce2'; x.lineWidth=1;
  for(let i=0;i<=5;i++){
    const y=top+plotH*i/5;
    x.beginPath();x.moveTo(left,y);x.lineTo(w-right,y);x.stroke();
    x.fillStyle='#c13f3f';x.textAlign='right';
    x.fillText((tempHi-(tempHi-tempLo)*i/5).toFixed(1)+'°',left-8,y+4);
    x.fillStyle='#286aa6';x.textAlign='left';
    x.fillText((humHi-(humHi-humLo)*i/5).toFixed(1)+'%',w-right+8,y+4);
  }
  const drawSeries=(values,color,lo,hi)=>{
    x.strokeStyle=color;x.fillStyle=color;x.lineWidth=2;x.beginPath();
    values.forEach((value,i)=>{
      const pointX=px(i),pointY=top+(hi-value)/(hi-lo)*plotH;
      i?x.lineTo(pointX,pointY):x.moveTo(pointX,pointY);
    });
    if(records.length>1)x.stroke();
    values.forEach((value,i)=>{
      const pointY=top+(hi-value)/(hi-lo)*plotH;
      x.beginPath();x.arc(px(i),pointY,records.length===1?4:2.5,0,Math.PI*2);x.fill();
    });
  };
  drawSeries(temps,'#d14b4b',tempLo,tempHi);
  drawSeries(hums,'#3178c6',humLo,humHi);
  x.fillStyle='#727780';x.textAlign='left';
  x.fillText(records[0].time,left,h-10);
  if(records.length>1){x.textAlign='right';x.fillText(records.at(-1).time,w-right,h-10)}
}

async function autoRefresh(force=false){
  if((document.hidden&&!force)||refreshing||loading||downloading||$('sync').disabled) return;
  refreshing=true;
  setAutoRefresh('自动刷新：刷新中…','refreshing');
  try{
    const previousTotal=meta?.recordCount??0;
    const previousLastUnix=meta?.lastUnix??0;
    await refreshMeta();
    if(historyCursor===null){
      await loadMore({feedback:false});
    }else if(meta.recordCount<previousTotal||(meta.recordCount===previousTotal&&meta.lastUnix!==previousLastUnix&&meta.recordCount===meta.capacity)){
      resetHistory();
      await loadMore({feedback:false});
    }else if(meta.recordCount>previousTotal){
      const added=meta.recordCount-previousTotal;
      if(added>60){
        resetHistory();
        await loadMore({feedback:false});
      }else{
        const batch=await api(`/api/records?start=${previousTotal}&count=${added}`);
        records.push(...batch);
        for(const r of batch) $('rows').prepend(createRecordRow(r));
        $('loaded').textContent=`已加载 ${records.length} / ${meta.recordCount} 条`;
        drawChart();
      }
    }
    updateLoadButton();
    updateDownloadButton();
    setAutoRefresh(`自动刷新：已开启 · ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`,'ok');
  }catch(e){
    setAutoRefresh(`自动刷新失败：${e.message}`,'error');
  }finally{refreshing=false}
}

$('loadMore').dataset.defaultLabel=$('loadMore').textContent.trim();
$('sync').dataset.defaultLabel=$('sync').textContent.trim();
$('download').dataset.defaultLabel=$('download').textContent.trim();
$('tempCorrection').addEventListener('input',event=>previewCorrection('temperature',event.currentTarget,-20,20));
$('humCorrection').addEventListener('input',event=>previewCorrection('humidity',event.currentTarget,-50,50));
$('tempCorrection').addEventListener('change',()=>{
  const value=Number($('tempCorrection').value);
  if(!Number.isFinite(value))return renderCorrections();
  corrections.temperature=Math.max(-20,Math.min(20,value));
  saveCorrections();
});
$('humCorrection').addEventListener('change',()=>{
  const value=Number($('humCorrection').value);
  if(!Number.isFinite(value))return renderCorrections();
  corrections.humidity=Math.max(-50,Math.min(50,value));
  saveCorrections();
});
$('resetCorrection').onclick=()=>{
  corrections={...correctionDefaults};
  saveCorrections();
};
$('loadMore').onclick=loadMore;
$('download').onclick=async()=>{
  downloading=true;
  setButtonLoading('download',true,'正在读取全部记录…');
  setStatus(`正在从设备读取全部 ${meta?.recordCount??0} 条历史记录并生成 CSV…`,'loading');
  try{
    const response=await fetch('/api/records.csv');
    if(!response.ok){
      const error=await response.json();
      throw new Error(error.error||response.statusText);
    }
    const exportCorrections={...corrections};
    const csvRows=(await response.text()).replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/).map(line=>line.split(','));
    csvRows[0][2]=`温度 °C（修正 ${signed(exportCorrections.temperature)}）`;
    csvRows[0][3]=`湿度 %RH（修正 ${signed(exportCorrections.humidity)}）`;
    for(const row of csvRows.slice(1)){
      row[2]=(Number(row[2])+exportCorrections.temperature).toFixed(1);
      row[3]=(Number(row[3])+exportCorrections.humidity).toFixed(1);
    }
    const blob=new Blob(['\uFEFF'+csvRows.map(row=>row.join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'});
    const disposition=response.headers.get('Content-Disposition')||'';
    const match=disposition.match(/filename="?([^";]+)"?/i);
    const link=document.createElement('a');
    const url=URL.createObjectURL(blob);
    link.href=url;
    link.download=match?.[1]||'sin-th2-history.csv';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    setStatus(`CSV 下载成功，共 ${meta.recordCount} 条历史记录。`,'success',true);
  }catch(e){setStatus(`CSV 下载失败：${e.message}`,'error')}
  finally{
    downloading=false;
    setButtonLoading('download',false,'');
    updateDownloadButton();
  }
};
$('sync').onclick=async()=>{
  const firstConfirm=confirm('危险操作：设置时间会通过 0x11 写入完整配置，并清空设备中的全部历史记录。\n\n程序会同时把记录间隔设为 5 分钟。\n\n是否继续？（第一次确认）');
  if(!firstConfirm)return;
  const secondConfirm=confirm('最后确认：设备中的全部历史记录将被永久清空，无法恢复。\n\n确定立即设置时间吗？（第二次确认）');
  if(!secondConfirm)return;
  setButtonLoading('sync',true,'正在设置…');
  setStatus('正在写入设备配置并校验时间，请勿关闭页面…','loading');
  try{
    const r=await api('/api/sync-time',{method:'POST'});
    resetHistory();await refreshMeta();
    updateLoadButton();
    setStatus(`设置成功：设备时间 ${r.deviceTime}，记录间隔 5 分钟，历史记录已清空。`,'success');
  }catch(e){setStatus(`设置失败：${e.message}`,'error')}
  finally{setButtonLoading('sync',false,'')}
};

const box=$('scrollBox');
box.addEventListener('scroll',()=>{if(box.scrollTop+box.clientHeight>=box.scrollHeight-120)loadMore()});
window.addEventListener('resize',drawChart);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoRefresh()});

(async()=>{
  try{
    renderCorrections();
    await autoRefresh(true);
    setInterval(autoRefresh,refreshIntervalMs);
  }
  catch(e){setStatus(`初始化失败：${e.message}`,'error')}
})();
