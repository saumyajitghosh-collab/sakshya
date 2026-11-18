/* Sakshya client. The server is the source of truth: every change goes through /api and returns the new state. */
(function(){
'use strict';
var DAY=864e5,HOUR=36e5,MIN=6e4;
var S=null;
var ui={view:'overview',area:null,inc:null,vendor:null,tab:'rbi',busy:null,resetArm:false,obsFilter:'open',activity:null,verify:null,users:null};
var dlgHandler=null;

var SEG={
  large:{label:'Large PSO',live:[2025,3,1]},
  medium:{label:'Medium PSO',live:[2026,3,1]},
  small:{label:'Small PSO',live:[2028,3,1]}
};
var CATS=['Cyber attack','Outage of critical system or infrastructure','Internal fraud','Settlement delay','Other unusual incident'];
var MS=[['triaged','Triaged'],['evidence','Evidence window pulled'],['draft','Draft assembled'],['approved','Approved by compliance head'],['rbi','Filed with RBI'],['certin','Filed with CERT-In']];
var STATUS={draft:['Draft','mute'],submitted:['With auditor','warn'],accepted:['Relied on','good']};
var ROLE_LABEL={admin:'Administrator',compliance:'Compliance',auditor:'System auditor',viewer:'Board / viewer'};

/* ---------- roles ---------- */
function role(){return S&&S.me?S.me.role:'viewer';}
function E(){return role()==='admin'||role()==='compliance';}
function AUD(){return role()==='auditor';}
function ADMIN(){return role()==='admin';}

/* ---------- API ---------- */
function api(method,url,payload){
  var opts={method:method,headers:{'X-Sakshya':'1'},credentials:'same-origin'};
  if(payload instanceof FormData)opts.body=payload;
  else if(payload!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(payload);}
  return fetch(url,opts).then(function(r){
    if(r.status===401){location.href='/login?next='+encodeURIComponent(location.pathname+location.hash);throw new Error('Signed out');}
    return r.json().catch(function(){return {};}).then(function(j){if(!r.ok)throw new Error(j.error||('Request failed ('+r.status+')'));return j;});
  });
}
function mut(method,url,payload,msg,quiet){
  return api(method,url,payload).then(function(j){if(j.state)S=j.state;if(!quiet)render();if(msg)toast(typeof msg==='function'?msg(j):msg);return j;},function(e){toast(e.message);throw e;});
}

/* ---------- helpers ---------- */
function now(){return Date.now();}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function pad(n){return String(n).padStart(2,'0');}
function inr(n){return '₹'+Math.round(n||0).toLocaleString('en-IN');}
function lakh(n){return n>=1e7?'₹'+(n/1e7).toFixed(2)+' cr':'₹'+(n/1e5).toFixed(1)+' lakh';}
function fD(ms){return ms?new Date(ms).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'–';}
function fDs(ms){return new Date(ms).toLocaleDateString('en-GB',{day:'numeric',month:'short'});}
function fT(ms){var d=new Date(ms);return pad(d.getHours())+':'+pad(d.getMinutes());}
function fDT(ms){return fD(ms)+', '+fT(ms);}
function tz(){var o=-new Date().getTimezoneOffset();var s=o>=0?'+':'-';o=Math.abs(o);return 'UTC'+s+pad(Math.floor(o/60))+':'+pad(o%60);}
function dur(ms){ms=Math.max(0,ms);var h=Math.floor(ms/HOUR),m=Math.floor(ms%HOUR/MIN);return h?h+'h '+pad(m)+'m':m+'m';}
function hms(ms){ms=Math.abs(ms);var h=Math.floor(ms/HOUR),m=Math.floor(ms%HOUR/MIN),s=Math.floor(ms%MIN/1000);return pad(h)+':'+pad(m)+':'+pad(s);}
function days(ms){return Math.round(ms/DAY);}
function addM(ms,n){var d=new Date(ms);return new Date(d.getFullYear(),d.getMonth()+n,d.getDate(),d.getHours(),d.getMinutes()).getTime();}
function localInput(ms){var d=new Date(ms);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());}
function dateInput(ms){return localInput(ms||now()).slice(0,10);}
function short(h){return h?h.slice(0,10)+'…'+h.slice(-6):'no file attached';}
function lc(s){s=String(s||'');return s.charAt(0).toLowerCase()+s.slice(1);}
function bytes(n){return n==null?'':n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';}

/* ---------- financial year (¶36) ---------- */
function fyOf(ms,type){
  var d=new Date(ms),y=d.getFullYear(),m=d.getMonth();
  if(type==='cal')return {sy:y,start:new Date(y,0,1).getTime(),end:new Date(y+1,0,1).getTime(),label:'CY '+y};
  var sy=m>=3?y:y-1;
  return {sy:sy,start:new Date(sy,3,1).getTime(),end:new Date(sy+1,3,1).getTime(),label:'FY '+sy+'-'+String(sy+1).slice(2)};
}
function fyLabel(sy,type){return type==='cal'?'CY '+sy:'FY '+sy+'-'+String(sy+1).slice(2);}
function sarDue(fy,type){return type==='cal'?new Date(fy.sy+1,2,1).getTime():new Date(fy.sy+1,5,1).getTime();}
function liveMs(){var l=SEG[S.segment].live;return new Date(l[0],l[1],l[2]).getTime();}
function sarInfo(){
  var t=now(),live=liveMs(),ref=Math.max(t,live),fy=fyOf(ref,S.fyType),prev=fyOf(fy.start-1,S.fyType);
  if(t>=live&&t<sarDue(prev,S.fyType)&&prev.end>live)fy=prev;
  var due=sarDue(fy,S.fyType);
  return {fy:fy,due:due,days:Math.ceil((due-t)/DAY),live:live,isLive:t>=live};
}
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
function periodsFor(fy,cad){
  var len={m:1,q:3,h:6}[cad],s=new Date(fy.start),out=[];
  for(var i=0;i<12;i+=len){
    var a=new Date(s.getFullYear(),s.getMonth()+i,1).getTime(),b=new Date(s.getFullYear(),s.getMonth()+i+len,1).getTime(),n=i/len,key,label;
    if(cad==='m'){var d=new Date(a);key=d.getFullYear()+'-'+pad(d.getMonth()+1);label=MONTHS[d.getMonth()]+' '+d.getFullYear();}
    else{key=fy.label+(cad==='q'?' Q':' H')+(n+1);label=key;}
    out.push({key:key,label:label,start:a,end:b,first:i,len:len,n:n});
  }
  return out;
}
var CADN={m:'Monthly',q:'Quarterly',h:'Half-yearly'};

/* ---------- engines ---------- */
function obsDue(o){return addM(o.raised,3);}
function areaById(id){for(var i=0;i<S.areas.length;i++)if(S.areas[i].id===id)return S.areas[i];return null;}
function areaScore(a){
  if(!a.applicable)return null;
  var t=now(),fy=fyOf(t,S.fyType);
  var fresh=a.tod.filter(function(x){return t-x.at<=365*DAY;}).length;
  var tod=a.todReq?Math.min(1,fresh/a.todReq):1;
  var done=periodsFor(fy,a.cad).filter(function(p){return p.end<=t;});
  var cov={};a.toe.forEach(function(x){cov[x.period]=1;});
  var miss=done.filter(function(p){return !cov[p.key];});
  var toe=done.length?(done.length-miss.length)/done.length:1;
  var pastDue=S.obs.filter(function(o){return o.area===a.id&&o.status!=='closed'&&obsDue(o)<t;}).length;
  var items=a.tod.concat(a.toe),acc=items.filter(function(x){return x.status==='accepted';}).length;
  return {score:Math.max(0,Math.round(50*tod+50*toe-15*pastDue)),tod:tod,toe:toe,fresh:fresh,stale:a.tod.length-fresh,miss:miss,done:done,pastDue:pastDue,reliance:items.length?acc/items.length:0,items:items.length};
}
function band(s){return s>=85?['Ready','good']:s>=60?['Gaps','warn']:['At risk','bad'];}
function readiness(){
  var xs=S.areas.map(areaScore).filter(Boolean);
  var avg=xs.length?Math.round(xs.reduce(function(a,b){return a+b.score;},0)/xs.length):0,items=0,acc=0;
  S.areas.forEach(function(a){if(a.applicable)a.tod.concat(a.toe).forEach(function(x){items++;if(x.status==='accepted')acc++;});});
  return {avg:avg,n:xs.length,ready:xs.filter(function(x){return x.score>=85;}).length,gaps:xs.filter(function(x){return x.score>=60&&x.score<85;}).length,risk:xs.filter(function(x){return x.score<60;}).length,reliance:items?acc/items:0};
}
function norm(s){return String(s).toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\b(pvt|private|ltd|limited|llp|inc|co|and|the|india)\b/g,' ').replace(/\s+/g,' ').trim();}
function independence(){
  var a=null;S.auditors.forEach(function(x){if(x.id===S.auditor)a=x;});
  var cur=fyOf(now(),S.fyType).sy;
  if(!a)return {a:null,conflicts:[],checks:[],outside:[],cur:cur};
  var names=[a.name].concat(a.sisters).map(norm),conflicts=[],checks=[],outside=[];
  S.services.forEach(function(s){
    var n=norm(s.provider),stem=n.split(' ')[0],inWin=s.fy>=cur-2,exact=names.indexOf(n)>=0;
    var near=!exact&&stem.length>3&&names.some(function(x){return x.split(' ')[0]===stem;});
    if(exact||near){if(!inWin)outside.push(s);else if(exact)conflicts.push(s);else checks.push(s);}
  });
  return {a:a,conflicts:conflicts,checks:checks,outside:outside,cur:cur};
}
function vendorGaps(v){
  var t=now(),g=[];
  if(v.critical&&!v.agreement)g.push({sev:3,para:'¶5',text:'Ecosystem adherence agreement not signed',fix:'agreement',fixL:'Record signed agreement'});
  if(v.critical){
    if(!v.assuranceTo)g.push({sev:3,para:'¶19(c)',text:'No independent auditor assurance on cyber resilience',fix:'assurance',fixL:'Upload assurance report'});
    else if(v.assuranceTo<t)g.push({sev:3,para:'¶19(c)',text:'Assurance expired '+days(t-v.assuranceTo)+' days ago',fix:'assurance',fixL:'Upload renewed report'});
    else if(v.assuranceTo-t<60*DAY)g.push({sev:2,para:'¶19(c)',text:'Assurance expires in '+days(v.assuranceTo-t)+' days',fix:'assurance',fixL:'Upload renewed report'});
  }
  if(v.procured){
    if(!v.sourceObtained&&!v.escrow)g.push({sev:3,para:'¶17(c)',text:'Critical application with neither source code nor escrow',fix:'escrow',fixL:'Record escrow arrangement'});
    if(!v.sourceObtained&&v.lastChange&&(!v.devCert||v.lastChange>v.devCert))g.push({sev:3,para:'¶18(b)',text:'Code changed '+fDs(v.lastChange)+' after the last developer certificate'+(v.devCert?' ('+fDs(v.devCert)+')':''),fix:'devcert',fixL:'Upload fresh developer certificate'});
  }
  if(v.cloud){
    if(!v.cspAudit||t-v.cspAudit>365*DAY)g.push({sev:3,para:'¶26(c)',text:'CSP independent audit older than 12 months',fix:'cspaudit',fixL:'Upload CSP audit report'});
    else if(t-v.cspAudit>300*DAY)g.push({sev:2,para:'¶26(c)',text:'CSP audit report due in '+days(v.cspAudit+365*DAY-t)+' days',fix:'cspaudit',fixL:'Upload CSP audit report'});
    if(!v.cspBoard)g.push({sev:2,para:'¶26(c)',text:'Board sub-committee review of CSP audit pending',fix:'cspboard',fixL:'Record Board sub-committee review'});
  }
  return g;
}
function vendorState(v){var g=vendorGaps(v);if(!v.critical&&!g.length)return ['Non-critical','mute'];if(g.some(function(x){return x.sev===3;}))return ['Blocked','bad'];if(g.length)return ['Attention','warn'];return ['Clear','good'];}
function boardItems(){
  var b=S.board,t=now();
  return [
    {k:'dr',label:'DR drill',para:'¶23',last:b.dr,months:6,cad:'Half-yearly'},
    {k:'backup',label:'Backup restore test',para:'¶20(f)',last:b.backup,months:6,cad:'Half-yearly'},
    {k:'bcp',label:'BCP review',para:'¶23',last:b.bcp,months:12,cad:'Annual'}
  ].map(function(x){
    x.due=x.last?addM(x.last,x.months):null;
    x.state=!x.last?['Not recorded','bad']:x.due<t?['Overdue','bad']:(x.due-t<45*DAY?['Due in '+days(x.due-t)+'d','warn']:['On track','good']);
    return x;
  });
}
function filingStats(){var f=S.incidents.filter(function(i){return i.ms.rbi;});return {n:f.length,ok:f.filter(function(i){return i.ms.rbi-i.detected<=6*HOUR;}).length};}
function liveIncidents(){return S.incidents.filter(function(i){return !i.ms.rbi;}).sort(function(a,b){return a.detected-b.detected;});}
function attention(){
  var t=now(),out=[];
  liveIncidents().forEach(function(i){var l=i.detected+6*HOUR-t;out.push({s:3,t:i.id+': '+i.title,m:l>0?dur(l)+' left to file with RBI'+(i.cyber?' and CERT-In':''):'RBI filing overdue by '+dur(-l),p:'¶22(d)',go:'six-hour',inc:i.id});});
  var ind=independence();
  if(!ind.a)out.push({s:2,t:'No system auditor recorded',m:'Add the firm you propose to appoint so the ¶37 check can run',p:'¶37',go:'audit-room'});
  else if(ind.conflicts.length)out.push({s:3,t:ind.a.name+' cannot audit this cycle',m:ind.conflicts[0].provider+' provided '+lc(ind.conflicts[0].service)+' in '+fyLabel(ind.conflicts[0].fy,S.fyType),p:'¶37',go:'audit-room'});
  S.obs.filter(function(o){return o.status!=='closed'&&obsDue(o)<t;}).forEach(function(o){out.push({s:3,t:o.id+' past the three-month corrective limit',m:o.title+' · due '+fD(obsDue(o)),p:'¶41',go:'audit-room',area:o.area});});
  S.vendors.forEach(function(v){if(vendorState(v)[1]==='bad'){var g=vendorGaps(v).filter(function(x){return x.sev===3;});out.push({s:2,t:v.name+': '+lc(g[0].text),m:g.length>1?'+'+(g.length-1)+' more vendor gap'+(g.length>2?'s':''):v.service,p:g[0].para,go:'vendors',vendor:v.id});}});
  S.areas.forEach(function(a){var sc=areaScore(a);if(sc&&sc.score<60)out.push({s:2,t:a.name+' at '+sc.score+'% readiness',m:[sc.miss.length?sc.miss.length+' operating period'+(sc.miss.length>1?'s':'')+' without evidence':'',sc.fresh<a.todReq?'design evidence missing or stale':''].filter(Boolean).join('; '),p:'¶38',go:'audit-room',area:a.id});});
  boardItems().forEach(function(b){if(b.state[1]==='bad')out.push({s:2,t:b.label+(b.last?' overdue':' not recorded'),m:b.last?'Last done '+fD(b.last)+'; '+b.cad.toLowerCase()+' cadence':b.cad+' test required',p:b.para,go:'board-pack'});});
  var pend=S.board.reports.filter(function(r){return !r.placed;});
  if(pend.length)out.push({s:1,t:pend.length+' IT assessment report'+(pend.length>1?'s':'')+' for the next Board sub-committee',m:S.board.meeting?'Meeting on '+fD(S.board.meeting):'Set the next meeting date',p:'¶12',go:'board-pack'});
  return out.sort(function(a,b){return b.s-a.s;});
}

/* ---------- drafts (¶22(d)) ---------- */
function sortedEvents(i){return i.events.slice().sort(function(a,b){return a.at-b.at;});}
function autoNarr(i){
  var ev=sortedEvents(i),first=ev[0],det=null;
  ev.forEach(function(e){if(Math.abs(e.at-i.detected)<MIN&&!det)det=e;});
  var s='On '+fD(i.detected)+' at '+fT(i.detected)+', '+S.entity+' detected '+lc(i.title);
  if(det&&det.text.indexOf(i.title)<0)s+=' when '+det.src+' reported: '+lc(det.text.replace(/\.$/,''));
  s+='.';
  if(first&&first.at<i.detected)s+=' The earliest related activity in the evidence window was at '+fT(first.at)+' ('+first.src+').';
  var im=i.impact||{};
  if(im.customers||im.txns||im.value)s+=' Impact assessed so far: '+(im.customers||0).toLocaleString('en-IN')+' customers, '+(im.txns||0).toLocaleString('en-IN')+' transactions, '+inr(im.value)+'.';
  var acts=(i.actions||'').split('\n').map(function(x){return x.trim();}).filter(Boolean);
  if(acts.length)s+=' Actions taken: '+acts.map(function(x){return lc(x.replace(/\.$/,''));}).join('; ')+'.';
  return s+' Root cause analysis is under way and an update will follow.';
}
function wrap(text,width,indent){var words=String(text).split(/\s+/),lines=[],cur='';words.forEach(function(w){if((cur+' '+w).trim().length>width){lines.push(cur.trim());cur=w;}else cur+=' '+w;});if(cur.trim())lines.push(cur.trim());return lines.join('\n'+indent);}
function line(n,k,v){return ((n?n+'. ':'')+k).padEnd(30,' ')+': '+v;}
function indicators(i){var ips={};i.events.forEach(function(e){(e.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)||[]).forEach(function(x){ips[x]=1;});});return Object.keys(ips);}
var IND='                                ';
function draftRBI(i){
  var first=sortedEvents(i)[0],acts=(i.actions||'').split('\n').filter(function(x){return x.trim();}),im=i.impact||{},L=[];
  L.push('INITIAL REPORT OF UNUSUAL INCIDENT TO RBI · DRAFT');
  L.push('Under para 22(d), Master Directions RBI/DPSS/2026-27/475 (reporting format: Annex 1)');
  L.push('Field order follows Sakshya\'s generic schema; columns are mapped to the Annex 1 file at onboarding.');
  L.push('');
  L.push(line(1,'Reporting entity',S.entity+' ('+SEG[S.segment].label+(S.business?'; '+S.business:'')+')'));
  L.push(line(2,'Incident reference',i.id));
  L.push(line(3,'Report type','Initial report within 6 hours of detection'));
  L.push(line(4,'Incident category',i.cat+' (map to Annex 2 list)'));
  L.push(line(5,'Detected at',fDT(i.detected)+' ('+tz()+')'));
  L.push(line(6,'Earliest related event',first?fDT(first.at)+' ('+first.src+')':'Under investigation'));
  L.push(line(7,'Report prepared at',fDT(now())+' ('+tz()+')'));
  L.push(line(8,'Systems or services affected',wrap(i.systems||'Under investigation',60,IND)));
  L.push(line(9,'Description',wrap(i.narrative||autoNarr(i),60,IND)));
  L.push(line(10,'Customer impact',(im.customers||0).toLocaleString('en-IN')+' customers; '+(im.txns||0).toLocaleString('en-IN')+' transactions; '+inr(im.value)));
  L.push(line(11,'Actions taken',acts.length?wrap('- '+acts[0],60,IND):'Under way'));
  acts.slice(1).forEach(function(a){L.push(IND+wrap('- '+a,60,IND));});
  L.push(line(12,'Current status',i.status||'Under investigation'));
  L.push(line(13,'Reported to CERT-In',i.cyber?(i.ms.certin?'Yes, '+fDT(i.ms.certin):'Required; pending'):'Not a cyber security incident'));
  L.push(line(14,'Contact',[S.contact,S.phone].filter(Boolean).join(', ')||'Not set'));
  return L.join('\n');
}
function draftCERT(i){
  if(!i.cyber)return 'Not marked as a cyber security incident, so no CERT-In report is drafted.\nTick "Cyber security incident" in the facts panel if that changes.';
  var first=sortedEvents(i)[0],ips=indicators(i),L=[];
  L.push('CYBER SECURITY INCIDENT REPORT TO CERT-In · DRAFT');
  L.push('Within 6 hours of noticing (CERT-In Directions of 28 April 2022) and para 22(d) of the RBI Directions');
  L.push('');
  L.push(line(1,'Organisation',S.entity));
  L.push(line(2,'Sector','Financial services: non-bank payment system operator'));
  L.push(line(3,'Incident type',i.cat));
  L.push(line(4,'Occurred at (first event)',first?fDT(first.at)+' ('+tz()+')':'Under investigation'));
  L.push(line(5,'Noticed at',fDT(i.detected)+' ('+tz()+')'));
  L.push(line(6,'Affected systems',wrap(i.systems||'Under investigation',60,IND)));
  L.push(line(7,'Indicators',ips.length?wrap(ips.join(', '),60,IND):'None extracted from evidence'));
  L.push(line(8,'Description',wrap(i.narrative||autoNarr(i),60,IND)));
  L.push(line(9,'Actions taken',wrap((i.actions||'Under way').split('\n').filter(Boolean).join('; '),60,IND)));
  L.push(line(10,'Point of contact',[S.contact,S.phone].filter(Boolean).join(', ')||'Not set'));
  return L.join('\n');
}
function boardNote(){
  var r=readiness(),f=filingStats(),ind=independence(),t=now(),sar=sarInfo();
  var pd=S.obs.filter(function(o){return o.status!=='closed'&&obsDue(o)<t;});
  var crit=S.vendors.filter(function(v){return v.critical;}),clear=crit.filter(function(v){return vendorState(v)[1]==='good';});
  var L=[];
  L.push('# Cyber resilience note for the Board IT oversight sub-committee');
  L.push(S.entity+' · meeting of '+(S.board.meeting?fD(S.board.meeting):'(date to be set)')+' · prepared '+fD(t));
  L.push('');
  L.push('## Position against the Master Directions');
  L.push('- System audit report for '+sar.fy.label+' due '+fD(sar.due)+' ('+sar.days+' days); control readiness '+r.avg+'% across '+r.n+' applicable areas under para 38, with '+Math.round(r.reliance*100)+'% of evidence already relied on by the auditor.');
  L.push('- Audit observations past the three-month corrective limit (para 41): '+(pd.length?pd.map(function(o){return o.id;}).join(', '):'none')+'.');
  L.push('- Auditor independence (para 37): '+(!ind.a?'no auditor recorded.':ind.conflicts.length?'proposed auditor '+ind.a.name+' is conflicted by '+ind.conflicts[0].provider+' ('+ind.conflicts[0].service+', '+fyLabel(ind.conflicts[0].fy,S.fyType)+'). A different firm is needed.':ind.a.name+' passes the check.'));
  L.push('- Incident reports filed within six hours (para 22(d)): '+f.ok+' of '+f.n+'.');
  L.push('- Critical vendors with complete evidence (paras 5, 17(c), 18(b), 19(c), 26(c)): '+clear.length+' of '+crit.length+'.');
  L.push('');
  L.push('## Resilience tests');
  boardItems().forEach(function(b){L.push('- '+b.label+' ('+b.para+', '+b.cad.toLowerCase()+'): '+(b.last?'last '+fD(b.last)+', next due '+fD(b.due):'not recorded')+' · '+b.state[0]+'.');});
  L.push('');
  L.push('## IT assessment reports placed under para 12');
  var pend=S.board.reports.filter(function(x){return !x.placed;});
  if(pend.length)pend.forEach(function(x){L.push('- '+x.name+' ('+x.by+', received '+fD(x.received)+')');});else L.push('- None pending.');
  L.push('');
  L.push('## Decisions sought');
  if(ind.conflicts.length)L.push('- Approve appointment of an independent system auditor for '+sar.fy.label+'.');
  if(pd.length)L.push('- Note overdue observations and approve revised closure dates.');
  boardItems().filter(function(b){return b.state[1]==='bad';}).forEach(function(b){L.push('- Direct management to complete the '+b.label.toLowerCase()+' before the next meeting.');});
  L.push('- Note the reports listed under para 12.');
  return L.join('\n');
}
function roi(){
  var p=S.pricing,areas=Math.max(1,S.areas.filter(function(a){return a.applicable;}).length),crit=S.vendors.filter(function(v){return v.critical;}).length;
  var price=p.platform+areas*p.perArea+crit*p.perVendor+p.desk;
  var audit=areas*p.audHrs*p.audRate*p.audCut/100,internal=areas*p.intHrs*p.intRate*p.intCut/100;
  var filing=p.filings*Math.max(0,p.asmManual-p.asmTool)*p.team*p.intRate,vendor=crit*p.vendorHrs*p.intRate*p.intCut/100,save=audit+internal+filing+vendor;
  return {areas:areas,crit:crit,price:price,audit:audit,internal:internal,filing:filing,vendor:vendor,save:save,net:save-price,payback:save>0?price/save*12:null,perArea:price/areas,savePerArea:(audit+internal)/areas};
}

/* ---------- shell ---------- */
var VIEWS=[['overview','Overview',''],['audit-room','Audit Room','¶36–41'],['six-hour','Six-Hour Desk','¶22(d)'],['vendors','Vendor Flow-down','¶5 ¶19(c)'],['board-pack','Board Pack','¶11 ¶12'],['activity','Activity log',''],['team','Team',''],['pricing','Pricing and ROI','']];
function route(){var h=(location.hash||'').replace('#','');ui.view=VIEWS.some(function(v){return v[0]===h;})?h:'overview';}
function shell(){
  var sar=sarInfo(),dis=E()?'':' disabled';
  document.getElementById('tenant').innerHTML=(S.isDemo?'<span class="demo">Demo workspace</span>':'')+'<span class="nm">'+esc(S.entity)+'</span><span class="sm">'+esc(SEG[S.segment].label)+(S.business?' · '+esc(S.business):'')+'</span><span class="sm">SAR '+esc(sar.fy.label)+' due '+fD(sar.due)+'</span>';
  document.getElementById('nav').innerHTML=VIEWS.map(function(v){return '<a class="nav-i'+(ui.view===v[0]?' on':'')+'" href="#'+v[0]+'"><span>'+v[1]+'</span>'+(v[2]?'<span class="p">'+v[2]+'</span>':'')+'</a>';}).join('');
  document.getElementById('railfoot').innerHTML=
    '<div><label for="set-seg">PSO category (¶3)</label><select id="set-seg" data-set="segment"'+dis+'>'+Object.keys(SEG).map(function(k){return '<option value="'+k+'"'+(S.segment===k?' selected':'')+'>'+SEG[k].label+'</option>';}).join('')+'</select></div>'+
    '<div><label for="set-fy">Financial year</label><select id="set-fy" data-set="fyType"'+dis+'><option value="apr"'+(S.fyType==='apr'?' selected':'')+'>Apr–Mar · file by 1 Jun</option><option value="cal"'+(S.fyType==='cal'?' selected':'')+'>Jan–Dec · file by 1 Mar</option></select></div>'+
    (S.isDemo&&ADMIN()?'<button type="button" data-act="reset">'+(ui.resetArm?'Click again to reset the demo':'Reset demo data')+'</button>':'')+
    '<div class="fine">Clause references: RBI Master Directions on Cyber Resilience and Digital Payment Security Controls for non-bank PSOs, 5 Nov 2026 (RBI/DPSS/2026-27/475).'+(S.isDemo?' Entities, people and figures in this workspace are fictional.':'')+'</div>';
  document.getElementById('me').innerHTML='<b>'+esc(S.me.name)+'</b>'+esc(ROLE_LABEL[S.me.role]||S.me.role);
}
function render(){
  if(!S)return;
  shell();
  var f={overview:vOverview,'audit-room':vAudit,'six-hour':vDesk,vendors:vVendors,'board-pack':vBoard,activity:vActivity,team:vTeam,pricing:vPricing}[ui.view];
  document.getElementById('main').innerHTML='<div class="wrap">'+f()+'</div>';
  tick();
}
function chip(t,c){return '<span class="chip '+(c||'')+'">'+esc(t)+'</span>';}
function para(p){return '<span class="para">'+esc(p)+'</span>';}
function meter(v,c){return '<div class="meter"><b style="width:'+Math.max(0,Math.min(100,v))+'%;background:var(--'+c+')"></b></div>';}
function kpi(v,l,c){return '<div class="kpi"><div class="v"'+(c?' style="color:var(--'+c+')"':'')+'>'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>';}
function roNote(){return E()?'':'<span class="ro">'+(AUD()?'Auditor view':'Read only')+'</span>';}
function statusCtl(x){
  var s=STATUS[x.status]||STATUS.draft;
  if(E()&&(x.status==='draft'||x.status==='submitted'))return '<button class="chip '+s[1]+'" data-act="evStatus" data-id="'+x.id+'" data-to="'+(x.status==='draft'?'submitted':'draft')+'" title="'+(x.status==='draft'?'Submit to the auditor':'Withdraw from the auditor')+'">'+s[0]+'</button>';
  if(AUD()&&(x.status==='submitted'||x.status==='accepted'))return '<button class="chip '+s[1]+'" data-act="evStatus" data-id="'+x.id+'" data-to="'+(x.status==='submitted'?'accepted':'submitted')+'" title="'+(x.status==='submitted'?'Mark as relied on':'Withdraw reliance')+'">'+(x.status==='submitted'?'Rely on this':s[0])+'</button>';
  return chip(s[0],s[1]);
}
function dlLink(x){return x.hasFile?' · <a class="dl" href="/api/evidence/'+x.id+'/file">download '+esc(bytes(x.size))+'</a>':'';}

/* ---------- Overview ---------- */
function vOverview(){
  var t=now(),sar=sarInfo(),r=readiness(),f=filingStats(),live=liveIncidents(),att=attention();
  var crit=S.vendors.filter(function(v){return v.critical;}),clear=crit.filter(function(v){return vendorState(v)[1]==='good';});
  var pd=S.obs.filter(function(o){return o.status!=='closed'&&obsDue(o)<t;}).length;
  var h='<div class="ph"><div><div class="eyebrow">'+esc(S.entity)+' · '+esc(SEG[S.segment].label)+' · '+fD(t)+'</div><h1>Evidence position today</h1><p class="lede">Two dated obligations drive the year: the six-hour incident filing and the annual system audit report. Everything else here feeds one of them.</p></div></div>';
  h+='<section class="hero">';
  if(live.length){
    var i=live[0],dl=i.detected+6*HOUR;
    h+='<div class="clock"><div class="top"><span>'+para('¶22(d)')+' &nbsp;'+esc(i.id)+' · '+esc(i.cat)+'</span><span>RBI'+(i.cyber?' + CERT-In':'')+'</span></div><div class="ttl">'+esc(i.title)+'</div><div class="big" data-deadline="'+dl+'">--:--:--</div>'+
      '<div class="sub">left in the six-hour window · detected '+fT(i.detected)+', file by '+fT(dl)+(live.length>1?' · '+(live.length-1)+' more open':'')+'</div><div class="bar"><b data-pfrom="'+i.detected+'" data-pto="'+dl+'"></b></div>'+
      '<a class="btn" href="#six-hour" data-act="go" data-inc="'+esc(i.id)+'">Open the filing desk</a></div>';
  }else{
    var last=S.incidents.filter(function(x){return x.ms.rbi;}).sort(function(a,b){return b.ms.rbi-a.ms.rbi;})[0];
    h+='<div class="clock idle"><div class="top"><span>'+para('¶22(d)')+' &nbsp;Six-hour clock</span></div><div class="big">No incident on the clock</div><div class="sub">'+(last?'Last filing: '+esc(last.id)+', filed '+dur(last.ms.rbi-last.detected)+' after detection.':'No filings yet.')+'</div><a class="btn" href="#six-hour">Open the filing desk</a></div>';
  }
  h+='<div class="card sar"><div class="card-h"><h2>System audit report '+esc(sar.fy.label)+'</h2>'+para('¶36')+'</div>';
  if(!sar.isLive)h+='<p class="small muted" style="margin:0 0 8px">Controls apply to '+esc(SEG[S.segment].label)+'s from '+fD(sar.live)+': '+Math.max(0,Math.round((sar.live-t)/(30.44*DAY)))+' months of runway.</p>';
  h+='<div class="row" style="align-items:baseline;gap:12px"><span class="big">'+sar.days+'</span><span class="muted">days until the filing deadline, '+fD(sar.due)+'</span></div>';
  var fs=new Date(sar.fy.start),cells='',labs='';
  for(var k=0;k<14;k++){
    var ms=new Date(fs.getFullYear(),fs.getMonth()+k,1).getTime(),me=new Date(fs.getFullYear(),fs.getMonth()+k+1,1).getTime(),cls=k>=12?'win':'',st='';
    if(me<=t)cls+=' done';else if(ms<=t){cls+=' now';st=' style="--pct:'+Math.round((t-ms)/(me-ms)*100)+'%"';}
    cells+='<i class="'+cls+'"'+st+' title="'+new Date(ms).toLocaleDateString('en-GB',{month:'long',year:'numeric'})+(k>=12?' · filing window':'')+'"></i>';
    labs+='<span>'+MONTHS[new Date(ms).getMonth()].charAt(0)+'</span>';
  }
  h+='<div class="fy" aria-label="Financial year and filing window">'+cells+'</div><div class="fy-l">'+labs+'</div><div class="legend" style="margin-top:8px"><span><i style="background:var(--accent)"></i>Year elapsed</span><span><i style="background:var(--warn)"></i>Two-month filing window</span></div>';
  h+='<div class="split2" style="margin-top:12px"><div class="stat"><div class="v">'+r.avg+'%</div><div class="l">Control readiness, '+r.n+' areas (¶38)</div></div><div class="stat"><div class="v">'+Math.round(r.reliance*100)+'%</div><div class="l">Evidence the auditor already relies on</div></div></div></div></section>';
  h+='<section class="kpis">'+kpi(r.ready+' / '+r.n,'Control areas ready for TOD and TOE testing')+kpi(String(pd),'Observations past the three-month limit (¶41)',pd?'bad':'good')+kpi(f.ok+' of '+f.n,'Incident reports filed inside six hours',f.ok<f.n?'warn':'good')+kpi(clear.length+' of '+crit.length,'Critical vendors with complete evidence',clear.length<crit.length?'warn':'good')+'</section>';
  h+='<section class="grid2"><div class="card"><div class="card-h"><h2>Needs attention</h2><span class="muted small">'+att.length+' items, most urgent first</span></div><div class="att">'+
    (att.length?att.slice(0,9).map(function(a){return '<a href="#'+a.go+'" data-act="go"'+(a.inc?' data-inc="'+esc(a.inc)+'"':'')+(a.area?' data-area="'+a.area+'"':'')+(a.vendor?' data-vendor="'+a.vendor+'"':'')+'><span class="sv s'+a.s+'"></span><span><span class="t">'+esc(a.t)+'</span><br><span class="m">'+esc(a.m)+'</span></span>'+para(a.p)+'</a>';}).join(''):'<div class="empty">Nothing outstanding.</div>')+'</div></div>';
  h+='<div class="card"><div class="card-h"><h2>Readiness by control area</h2>'+para('¶38')+'</div><div class="areas-mini">'+S.areas.map(function(a){var sc=areaScore(a);if(!sc)return '<a href="#audit-room" data-act="go" data-area="'+a.id+'"><span class="muted">'+esc(a.name)+'</span><span class="small muted">Not applicable</span><span></span></a>';var b=band(sc.score);return '<a href="#audit-room" data-act="go" data-area="'+a.id+'"><span>'+esc(a.name)+'</span>'+meter(sc.score,b[1])+'<span class="score" style="color:var(--'+b[1]+')">'+sc.score+'</span></a>';}).join('')+'</div></div></section>';
  return h;
}

/* ---------- Audit Room ---------- */
function stripFor(a){
  var t=now(),fy=fyOf(t,S.fyType),ps=periodsFor(fy,a.cad),cov={},cells='',fs=new Date(fy.start);
  a.toe.forEach(function(x){cov[x.period]=1;});
  for(var i=0;i<12;i++){
    var p=null;ps.forEach(function(q){if(i>=q.first&&i<q.first+q.len)p=q;});
    var ms=new Date(fs.getFullYear(),fs.getMonth()+i,1).getTime(),cls,lab;
    if(ms>t){cls='';lab='not started';}else if(p.end>t){cls=cov[p.key]?'c':'w';lab=cov[p.key]?'in progress, evidence attached':'in progress';}else if(cov[p.key]){cls='c';lab='evidence attached';}else{cls='m';lab='no evidence';}
    cells+='<i class="'+cls+'" title="'+esc(p.label)+': '+lab+'"></i>';
  }
  return '<div class="strip" aria-label="Operating evidence by month">'+cells+'</div>';
}
function vAudit(){
  var r=readiness(),sar=sarInfo(),t=now();
  if(!ui.area||!areaById(ui.area)){var worst=null,ws=101;S.areas.forEach(function(a){var s=areaScore(a);if(s&&s.score<ws){ws=s.score;worst=a.id;}});ui.area=worst||S.areas[0].id;}
  var h='<div class="ph"><div><div class="eyebrow">Paras 36 to 41 · '+esc(sar.fy.label)+' · report due '+fD(sar.due)+'</div><h1>Audit Room</h1><p class="lede">Each control area the auditor must comment on under ¶38, with design (TOD) and operating (TOE) evidence collected through the year. Every file is hashed on upload and every action is written to a tamper-evident log, so the auditor can rely on it without re-performing the test.</p></div>'+
    '<div class="row">'+roNote()+'<a class="btn" href="/api/export/manifest.csv">Manifest CSV</a><a class="btn" href="/api/export/pack.json">Pack JSON</a><a class="btn primary" href="/api/export/evidence.zip">Auditor evidence ZIP</a></div></div>';
  h+='<section class="kpis">'+kpi(r.avg+'%','Overall readiness')+kpi(String(r.ready),'Areas ready',r.ready===r.n?'good':'')+kpi(String(r.gaps),'Areas with gaps',r.gaps?'warn':'good')+kpi(String(r.risk),'Areas at risk',r.risk?'bad':'good')+'</section>';
  h+='<section class="split"><div class="card"><div class="card-h"><h2>Control areas</h2><div class="legend"><span><i style="background:var(--accent)"></i>Evidence</span><span><i style="background:var(--bad)"></i>Missing</span><span><i style="box-shadow:inset 0 0 0 1px var(--line)"></i>In progress</span></div></div><div class="tbl-w"><table class="tbl"><thead><tr><th>Area</th><th>Design</th><th>Operating, '+esc(fyOf(t,S.fyType).label)+'</th><th class="r">Score</th></tr></thead><tbody>'+
    S.areas.map(function(a){var sc=areaScore(a);
      if(!sc)return '<tr class="click'+(ui.area===a.id?' sel':'')+'" data-act="area" data-id="'+a.id+'"><td>'+esc(a.name)+'</td><td colspan="2" class="muted small">Marked not applicable</td><td class="r">'+chip('N/A','mute')+'</td></tr>';
      var b=band(sc.score);
      return '<tr class="click'+(ui.area===a.id?' sel':'')+'" data-act="area" data-id="'+a.id+'"><td><div>'+esc(a.name)+'</div><div class="small muted">'+CADN[a.cad]+' · '+esc(a.owner)+'</div></td><td>'+(sc.fresh>=a.todReq?chip(sc.fresh+'/'+a.todReq+' fresh','good'):chip(sc.fresh+'/'+a.todReq+(sc.stale?' · stale':''),'bad'))+'</td><td>'+stripFor(a)+'</td><td class="r"><span class="score" style="color:var(--'+b[1]+')">'+sc.score+'</span></td></tr>';}).join('')+
    '</tbody></table></div><p class="small muted" style="margin:10px 0 0">Score = 50 × share of required design artefacts reviewed in the last 12 months + 50 × share of completed periods with operating evidence − 15 for each observation past its ¶41 deadline.</p></div>';
  h+=areaDetail(areaById(ui.area))+'</section>';
  var obs=S.obs.filter(function(o){return ui.obsFilter==='all'||(ui.obsFilter==='open'?o.status!=='closed':o.status==='closed');});
  h+='<section class="card"><div class="card-h"><div class="row"><h2>Audit observations</h2>'+para('¶39–41')+'</div><div class="row"><div class="tabs" style="margin:0;border:0">'+[['open','Open'],['closed','Closed'],['all','All']].map(function(x){return '<button data-act="obsFilter" data-v="'+x[0]+'" class="'+(ui.obsFilter===x[0]?'on':'')+'">'+x[1]+'</button>';}).join('')+'</div>'+(E()||AUD()?'<button class="btn sm" data-act="addObs">Log observation</button>':'')+'</div></div>'+
    '<div class="tbl-w"><table class="tbl"><thead><tr><th>Ref</th><th>Observation</th><th>Area</th><th>Raised</th><th>Corrective due (3 months)</th><th>Status</th><th></th></tr></thead><tbody>'+
    (obs.length?obs.map(function(o){var due=obsDue(o),late=o.status!=='closed'&&due<t,a=areaById(o.area);
      var st=o.status==='open'?chip(late?'Overdue':'Open',late?'bad':'warn'):o.status==='submitted'?chip('Fix with auditor',late?'bad':'accent'):chip('Closed by auditor','good');
      var act='';
      if(E()){if(o.status==='open')act='<button class="btn sm" data-act="obsTo" data-id="'+o.id+'" data-to="submitted">Submit fix to auditor</button>';else if(o.status==='closed')act='<button class="btn sm" data-act="obsTo" data-id="'+o.id+'" data-to="open">Reopen</button>';else act='<span class="small muted">Awaiting auditor</span>';}
      else if(AUD()){if(o.status==='submitted')act='<div class="row" style="justify-content:flex-end"><button class="btn sm primary" data-act="obsTo" data-id="'+o.id+'" data-to="closed">Accept closure</button><button class="btn sm" data-act="obsTo" data-id="'+o.id+'" data-to="open">Return</button></div>';else if(o.status==='closed')act='<button class="btn sm" data-act="obsTo" data-id="'+o.id+'" data-to="open">Reopen</button>';}
      return '<tr><td class="mono">'+esc(o.id)+'</td><td><div>'+esc(o.title)+'</div><div class="small muted">'+esc(o.sev)+' · '+esc(o.source)+'</div></td><td class="small">'+esc(a?a.name:o.area)+'</td><td class="small num">'+fD(o.raised)+'</td><td class="small num" style="color:var(--'+(late?'bad':'ink')+')">'+fD(due)+(o.status!=='closed'?'<br><span class="muted">'+(late?days(t-due)+' days late':days(due-t)+' days left')+'</span>':'')+'</td><td>'+st+'</td><td class="r">'+act+'</td></tr>';}).join(''):'<tr><td colspan="7"><div class="empty">No observations in this view.</div></td></tr>')+
    '</tbody></table></div><p class="small muted" style="margin:10px 0 0">An observation counts as closed only when the system auditor accepts the closure in Sakshya.</p></section>';
  return h+indepCard();
}
function areaDetail(a){
  var sc=areaScore(a),t=now(),fy=fyOf(t,S.fyType);
  var h='<div class="card" id="area-detail"><div class="card-h"><div><div class="eyebrow">¶38 control area · owner '+esc(a.owner)+'</div><h2 style="margin-top:4px">'+esc(a.name)+'</h2></div>'+
    (E()?'<label class="check"><input type="checkbox" data-act="applicable" data-id="'+a.id+'"'+(a.applicable?' checked':'')+'> Applicable</label>':(a.applicable?'':chip('Not applicable','mute')))+'</div>';
  if(!sc)return h+'<div class="empty">Marked not applicable for this entity. ¶38 lists Mobile Online Services as applicable only where services are offered through mobile apps; record the reason in your audit scope note.</div></div>';
  var b=band(sc.score);
  h+='<div class="split2"><div class="stat"><div class="v" style="color:var(--'+b[1]+')">'+sc.score+'%</div><div class="l">'+b[0]+' · '+Math.round(sc.reliance*100)+'% relied on by auditor</div></div><div class="stat small"><div>Design: '+Math.round(sc.tod*50)+' / 50</div><div>Operating: '+Math.round(sc.toe*50)+' / 50</div><div>Overdue observations: '+(sc.pastDue?'−'+15*sc.pastDue:'0')+'</div></div></div>';
  h+='<div class="card-h" style="margin:16px 0 6px"><h3>Design evidence (TOD) · '+a.todReq+' required</h3>'+(E()?'<button class="btn sm" data-act="addEv" data-id="'+a.id+'" data-kind="tod">Add design evidence</button>':'')+'</div>';
  h+=a.tod.length?'<div class="tbl-w"><table class="tbl"><tbody>'+a.tod.map(function(x){return '<tr><td><div>'+esc(x.name)+'</div><div class="hash">'+esc(x.source)+' · '+fD(x.at)+' · '+short(x.hash)+dlLink(x)+'</div></td><td>'+(t-x.at>365*DAY?chip('Stale','bad'):'')+'</td><td class="r">'+statusCtl(x)+'</td></tr>';}).join('')+'</tbody></table></div>':'<div class="empty">No design artefact on file. Upload the approved policy or procedure for this area.</div>';
  var ps=periodsFor(fy,a.cad),by={};a.toe.forEach(function(x){by[x.period]=x;});
  h+='<div class="card-h" style="margin:16px 0 6px"><h3>Operating evidence (TOE) · '+CADN[a.cad].toLowerCase()+'</h3>'+(E()?'<button class="btn sm" data-act="addEv" data-id="'+a.id+'" data-kind="toe">Add operating evidence</button>':'')+'</div>';
  h+='<div class="tbl-w"><table class="tbl"><tbody>'+ps.filter(function(p){return p.start<=t;}).map(function(p){var x=by[p.key];
    if(x)return '<tr><td class="mono" style="width:110px">'+esc(p.label)+'</td><td><div class="small">'+esc(x.name)+'</div><div class="hash">'+esc(x.source)+' · '+short(x.hash)+dlLink(x)+'</div></td><td class="r">'+statusCtl(x)+'</td></tr>';
    var open=p.end>t;
    return '<tr><td class="mono" style="width:110px">'+esc(p.label)+'</td><td class="small" style="color:var(--'+(open?'muted':'bad')+')">'+(open?'Period in progress':'No evidence for a completed period')+'</td><td class="r">'+(E()?'<button class="btn sm" data-act="addEv" data-id="'+a.id+'" data-kind="toe" data-period="'+esc(p.key)+'">Attach</button>':'')+'</td></tr>';}).join('')+'</tbody></table></div>';
  var o=S.obs.filter(function(x){return x.area===a.id&&x.status!=='closed';});
  if(o.length)h+='<div class="callout warn" style="margin-top:12px">'+o.map(function(x){return '<b>'+esc(x.id)+'</b> '+esc(x.title)+' · due '+fD(obsDue(x));}).join('<br>')+'</div>';
  return h+'</div>';
}
function indepCard(){
  var ind=independence();
  var h='<section class="card" id="indep"><div class="card-h"><div class="row"><h2>Auditor independence</h2>'+para('¶36')+para('¶37')+'</div>'+(E()?'<div class="row"><button class="btn sm" data-act="addAuditor">Add auditor firm</button><button class="btn sm" data-act="addSvc">Add service to the ledger</button></div>':'')+'</div>';
  h+='<p class="small muted" style="margin:0 0 12px;max-width:80ch">¶37 bars a firm, or any sister concern, that provided any service to the entity in the last two financial years. Sakshya checks the proposed auditor against your services ledger for the current year and the two before it. ¶36 requires a CERT-In empanelled auditor, or one holding CISA or DISA.</p>';
  if(!S.auditors.length)return h+'<div class="empty">No auditor firm recorded yet.'+(E()?' Add the firm you propose to appoint.':'')+'</div>'+svcTable()+'</section>';
  h+='<div class="fgrid"><div class="fld"><label class="f" for="aud">Proposed system auditor</label><select class="in" id="aud" data-set="auditor"'+(E()?'':' disabled')+'>'+(S.auditor?'':'<option value="">Choose a firm</option>')+S.auditors.map(function(a){return '<option value="'+a.id+'"'+(S.auditor===a.id?' selected':'')+'>'+esc(a.name)+' · '+esc(a.basis)+'</option>';}).join('')+'</select><div class="small muted" style="margin-top:6px">Sister concerns on file: '+(ind.a&&ind.a.sisters.length?esc(ind.a.sisters.join(', ')):'none declared')+'</div></div><div>';
  if(!ind.a)h+='<div class="callout">Choose the firm you propose to appoint.</div>';
  else if(ind.conflicts.length)h+='<div class="callout bad"><b>Conflict: this firm cannot audit '+esc(fyLabel(ind.cur,S.fyType))+'.</b><br>'+ind.conflicts.map(function(s){return esc(s.provider)+' provided '+esc(lc(s.service))+' in '+esc(fyLabel(s.fy,S.fyType))+'.';}).join('<br>')+'</div>';
  else if(ind.checks.length)h+='<div class="callout warn"><b>Check the relationship before appointing.</b><br>'+ind.checks.map(function(s){return esc(s.provider)+' shares a name with this firm and provided '+esc(lc(s.service))+' in '+esc(fyLabel(s.fy,S.fyType))+'.';}).join('<br>')+'</div>';
  else h+='<div class="callout good"><b>No conflict found in the ledger.</b> Keep the firm\'s declaration of independence with the audit file.</div>';
  if(ind.outside.length)h+='<p class="small muted">Outside the window: '+ind.outside.map(function(s){return esc(s.provider)+' ('+esc(fyLabel(s.fy,S.fyType))+')';}).join(', ')+'.</p>';
  return h+'</div></div>'+svcTable()+'</section>';
}
function svcTable(){
  return '<div class="tbl-w" style="margin-top:12px"><table class="tbl"><thead><tr><th>Service provider</th><th>Service</th><th>Year</th><th></th></tr></thead><tbody>'+(S.services.length?S.services.map(function(s){return '<tr><td>'+esc(s.provider)+'</td><td class="small">'+esc(s.service)+'</td><td class="mono">'+esc(fyLabel(s.fy,S.fyType))+'</td><td class="r">'+(E()?'<button class="btn sm danger" data-act="delSvc" data-id="'+s.id+'">Remove</button>':'')+'</td></tr>';}).join(''):'<tr><td colspan="4"><div class="empty">The services ledger is empty.</div></td></tr>')+'</tbody></table></div>';
}

/* ---------- Six-Hour Desk ---------- */
function incById(id){for(var i=0;i<S.incidents.length;i++)if(S.incidents[i].id===id)return S.incidents[i];return null;}
function vDesk(){
  if(!ui.inc||!incById(ui.inc)){var l=liveIncidents();ui.inc=(l[0]||S.incidents[0]||{}).id;}
  var f=filingStats();
  var h='<div class="ph"><div><div class="eyebrow">Para 22(d) · RBI within 6 hours of detection · CERT-In for cyber incidents</div><h1>Six-Hour Desk</h1><p class="lede">The detection time is locked when the incident is opened, and every step is stamped with server time. Sakshya pulls the evidence window, assembles the RBI and CERT-In drafts, and shows whether analysis or assembly is eating the clock.</p></div>'+(E()?'<button class="btn primary" data-act="newInc">Open an incident</button>':roNote())+'</div>';
  if(!S.incidents.length)return h+'<div class="empty">No incidents recorded.'+(E()?' Open one when an unusual incident is detected; the six-hour clock starts from the detection time.':'')+'</div>';
  h+='<section class="split inc"><div class="list">'+S.incidents.slice().sort(function(a,b){return (a.ms.rbi?1:0)-(b.ms.rbi?1:0)||b.detected-a.detected;}).map(function(i){
    var right=i.ms.rbi?chip('Filed in '+dur(i.ms.rbi-i.detected),i.ms.rbi-i.detected<=6*HOUR?'good':'bad'):'<span class="mono" data-deadline="'+(i.detected+6*HOUR)+'" data-fmt="chip">--</span>';
    return '<button class="item'+(ui.inc===i.id?' on':'')+'" data-act="inc" data-id="'+esc(i.id)+'"><span class="row" style="justify-content:space-between"><span class="mono">'+esc(i.id)+'</span>'+right+'</span><span style="font-weight:600">'+esc(i.title)+'</span><span class="small muted">'+esc(i.cat)+' · '+fDT(i.detected)+(i.cyber?' · CERT-In':'')+'</span></button>';}).join('')+
    '<p class="small muted">'+f.ok+' of '+f.n+' filings inside six hours.</p></div>';
  return h+incDetail(incById(ui.inc))+'</section>';
}
function incDetail(i){
  var t=now(),dl=i.detected+6*HOUR,filed=!!i.ms.rbi,ed=E(),dis=ed?'':' disabled';
  var h='<div style="display:grid;gap:16px;min-width:0">';
  h+='<div class="clock" style="padding:18px 20px"><div class="top"><span>'+para('¶22(d)')+' &nbsp;'+esc(i.id)+' · '+esc(i.cat)+'</span><span>Detected '+fDT(i.detected)+' · locked</span></div><div class="ttl">'+esc(i.title)+'</div>'+
    (filed?'<div class="big" style="font-size:56px;color:'+(i.ms.rbi-i.detected<=6*HOUR?'#7fe0a8':'#ff8a7d')+'">'+hms(i.ms.rbi-i.detected)+'</div><div class="sub">detection to RBI filing'+(i.cyber&&i.ms.certin?' · CERT-In filed after '+dur(i.ms.certin-i.detected):'')+'</div>'
      :'<div class="big" style="font-size:64px" data-deadline="'+dl+'">--:--:--</div><div class="sub">left to file with RBI'+(i.cyber?' and CERT-In':'')+' · deadline '+fT(dl)+' on '+fD(dl)+'</div><div class="bar"><b data-pfrom="'+i.detected+'" data-pto="'+dl+'"></b></div>')+'</div>';
  var an=(i.ms.evidence||Math.min(t,i.ms.rbi||t))-i.detected,as=i.ms.evidence?(i.ms.rbi||t)-i.ms.evidence:0;
  h+='<div class="grid2"><div class="card"><div class="card-h"><h2>Filing stopwatch</h2></div><div class="ms">'+MS.filter(function(m){return m[0]!=='certin'||i.cyber;}).map(function(m){var at=i.ms[m[0]];
    var btn=!ed?'':m[0]==='evidence'?'<button class="btn sm" data-act="ms" data-k="evidence" data-id="'+esc(i.id)+'">Pull evidence window</button>':m[0]==='draft'?'<button class="btn sm" data-act="ms" data-k="draft" data-id="'+esc(i.id)+'">Assemble draft</button>':'<button class="btn sm" data-act="ms" data-k="'+m[0]+'" data-id="'+esc(i.id)+'">Mark done</button>';
    return '<div class="r"><span class="dot'+(at?' on':'')+'"></span><span><div>'+m[1]+'</div>'+(at?'<div class="small muted num">'+fT(at)+' · +'+dur(at-i.detected)+' from detection</div>':'')+'</span>'+(at?'':btn)+'</div>';}).join('')+
    '</div><div class="split2" style="margin-top:12px"><div class="stat"><div class="v">'+dur(an)+'</div><div class="l">Analysis: detection to evidence</div></div><div class="stat"><div class="v">'+(i.ms.evidence?dur(as):'–')+'</div><div class="l">Assembly: evidence to filing'+(i.ms.rbi?'':' so far')+'</div></div></div></div>';
  h+='<div class="card"><div class="card-h"><h2>Facts for the filing</h2>'+roNote()+'</div><div style="display:grid;gap:10px">'+
    '<div class="fld"><label class="f" for="f-sys">Systems or services affected</label><input class="in" id="f-sys" data-inc="systems" value="'+esc(i.systems)+'"'+dis+'></div>'+
    '<div class="fgrid3"><div class="fld"><label class="f" for="f-c">Customers</label><input class="in num" id="f-c" type="number" min="0" data-inc="impact.customers" value="'+(i.impact.customers||0)+'"'+dis+'></div><div class="fld"><label class="f" for="f-t">Transactions</label><input class="in num" id="f-t" type="number" min="0" data-inc="impact.txns" value="'+(i.impact.txns||0)+'"'+dis+'></div><div class="fld"><label class="f" for="f-v">Value (₹)</label><input class="in num" id="f-v" type="number" min="0" data-inc="impact.value" value="'+(i.impact.value||0)+'"'+dis+'></div></div>'+
    '<div class="fld"><label class="f" for="f-a">Actions taken, one per line</label><textarea class="in" id="f-a" rows="4" data-inc="actions"'+dis+'>'+esc(i.actions)+'</textarea></div>'+
    '<div class="fld"><label class="f" for="f-s">Current status</label><input class="in" id="f-s" data-inc="status" value="'+esc(i.status)+'"'+dis+'></div>'+
    '<label class="check"><input type="checkbox" data-inc="cyber"'+(i.cyber?' checked':'')+dis+'> Cyber security incident (also report to CERT-In)</label></div></div></div>';
  var ev=sortedEvents(i),ips=indicators(i),srcs={};ev.forEach(function(e){srcs[e.src]=1;});
  h+='<div class="card"><div class="card-h"><div class="row"><h2>Evidence window</h2>'+(i.windowPulled?chip(ev.length+' events · '+Object.keys(srcs).length+' sources'):'')+'</div>'+(ed?'<button class="btn sm" data-act="addLogs" data-id="'+esc(i.id)+'">Paste log lines</button>':'')+'</div>';
  h+=i.windowPulled?(ev.length?'<div class="evs">'+ev.map(function(e){var det=Math.abs(e.at-i.detected)<MIN;return '<div class="ev'+(det?' det':'')+'"><span class="num">'+fT(e.at)+'</span><span class="src">'+esc(e.src)+'</span><span>'+esc(e.text)+(det?' <b>· detection</b>':'')+'</span></div>';}).join('')+'</div>'+(ips.length?'<p class="small" style="margin:10px 0 0"><span class="muted">Indicators extracted:</span> <span class="mono">'+esc(ips.join(', '))+'</span></p>':''):'<div class="empty">No events yet. Paste SIEM or application log lines; timestamps and IP addresses are read automatically.</div>')
    :'<div class="empty">Evidence window not pulled yet.'+(ev.length?' '+ev.length+' event'+(ev.length>1?'s are':' is')+' waiting.':'')+(ed?'<br><br><button class="btn primary" data-act="ms" data-k="evidence" data-id="'+esc(i.id)+'">Pull evidence window</button>':'')+'</div>';
  h+='</div>';
  h+='<div class="card"><div class="card-h"><h2>Drafts</h2><div class="row">'+(ed&&S.ai?'<button class="btn sm" data-act="polish" data-id="'+esc(i.id)+'"'+(ui.busy?' disabled':'')+'>'+(ui.busy==='polish'?'Claude is drafting…':'Draft description with Claude')+'</button>':'')+(ed?'<button class="btn sm" data-act="resetNarr" data-id="'+esc(i.id)+'">Rebuild description from facts</button>':'')+'</div></div>';
  h+='<div class="fld" style="margin-bottom:12px"><label class="f" for="narr">Description (both drafts use it)</label><textarea class="in" id="narr" rows="5" data-inc="narrative"'+dis+'>'+esc(i.narrative||autoNarr(i))+'</textarea></div>';
  h+='<div class="tabs"><button data-act="tab" data-v="rbi" class="'+(ui.tab==='rbi'?'on':'')+'">RBI report</button><button data-act="tab" data-v="certin" class="'+(ui.tab==='certin'?'on':'')+'">CERT-In report</button></div>';
  h+='<pre class="draft" id="draft-pre">'+esc(ui.tab==='rbi'?draftRBI(i):draftCERT(i))+'</pre><div class="row" style="margin-top:10px"><button class="btn" data-act="copyDraft" data-id="'+esc(i.id)+'">Copy draft</button><button class="btn" data-act="dlDraft" data-id="'+esc(i.id)+'">Download .txt</button></div></div>';
  return h+'</div>';
}

/* ---------- Vendors ---------- */
function vVendors(){
  var h='<div class="ph"><div><div class="eyebrow">Paras 5, 17(c), 18(b), 19(c), 26(c)</div><h1>Vendor Flow-down</h1><p class="lede">¶5 makes every PSO the distributor of these controls to its gateways, service providers and vendors. This register tracks the evidence each one owes you, and when it expires.</p></div>'+(E()?'<button class="btn primary" data-act="addVendor">Add vendor</button>':roNote())+'</div>';
  if(!S.vendors.length)return h+'<div class="empty">No vendors recorded yet.'+(E()?' Add the gateways, service providers and procured applications in your critical processes.':'')+'</div>';
  var crit=S.vendors.filter(function(v){return v.critical;}),c={good:0,warn:0,bad:0},t=now();
  crit.forEach(function(v){var k=vendorState(v)[1];c[k]=(c[k]||0)+1;});
  if(!ui.vendor||!S.vendors.some(function(v){return v.id===ui.vendor;})){var b=S.vendors.filter(function(v){return vendorState(v)[1]==='bad';})[0];ui.vendor=(b||S.vendors[0]).id;}
  h+='<section class="kpis">'+kpi(String(crit.length),'Vendors in critical processes')+kpi(String(c.good||0),'Clear',c.good?'good':'')+kpi(String(c.warn||0),'Need attention',c.warn?'warn':'')+kpi(String(c.bad||0),'Blocked on a mandatory artefact',c.bad?'bad':'')+'</section>';
  h+='<section class="split"><div class="card"><div class="tbl-w"><table class="tbl"><thead><tr><th>Vendor</th><th>¶5 agreement</th><th>¶19(c) assurance</th><th>Code ¶17–18</th><th>Status</th></tr></thead><tbody>'+S.vendors.map(function(v){var st=vendorState(v);
    var as=!v.critical?'<span class="muted small">n/a</span>':!v.assuranceTo?chip('Missing','bad'):v.assuranceTo<t?chip('Expired','bad'):chip('to '+fDs(v.assuranceTo),v.assuranceTo-t<60*DAY?'warn':'good');
    var code=!v.procured?'<span class="muted small">n/a</span>':(v.sourceObtained?chip('Source held','good'):v.escrow?chip('Escrow','good'):chip('No escrow','bad'));
    return '<tr class="click'+(ui.vendor===v.id?' sel':'')+'" data-act="vendor" data-id="'+v.id+'"><td><div>'+esc(v.name)+'</div><div class="small muted">'+esc(v.service)+(v.cloud?' · CSP':'')+'</div></td><td>'+(v.critical?(v.agreement?chip('Signed','good'):chip('Pending','bad')):'<span class="muted small">n/a</span>')+'</td><td>'+as+'</td><td>'+code+'</td><td>'+chip(st[0],st[1])+'</td></tr>';}).join('')+'</tbody></table></div></div>';
  var v=S.vendors.filter(function(x){return x.id===ui.vendor;})[0],g=vendorGaps(v),st=vendorState(v);
  h+='<div class="card"><div class="card-h"><div><div class="eyebrow">'+(v.critical?'Critical process':'Not in a critical process')+'</div><h2 style="margin-top:4px">'+esc(v.name)+'</h2></div>'+chip(st[0],st[1])+'</div><dl class="kv"><dt>Service</dt><dd>'+esc(v.service)+'</dd>'+
    (v.critical?'<dt>Assurance valid to</dt><dd>'+(v.assuranceTo?fD(v.assuranceTo):'None on file')+'</dd>':'')+
    (v.procured?'<dt>Source code</dt><dd>'+(v.sourceObtained?'Held by entity':v.escrow?'In escrow':'Neither held nor in escrow')+'</dd><dt>Last code change</dt><dd>'+fD(v.lastChange)+(E()?' · <a href="#vendors" data-act="vfix" data-id="'+v.id+'" data-fix="codechange">record a new change</a>':'')+'</dd><dt>Developer certificate</dt><dd>'+(v.devCert?fD(v.devCert):'None')+'</dd>':'')+
    (v.cloud?'<dt>CSP audit report</dt><dd>'+(v.cspAudit?fD(v.cspAudit):'None')+'</dd><dt>Board review</dt><dd>'+(v.cspBoard?'Done':'Pending')+'</dd>':'')+'</dl>';
  h+=g.length?'<div class="list" style="margin-top:14px">'+g.map(function(x){return '<div class="callout '+(x.sev===3?'bad':'warn')+'"><div class="row" style="justify-content:space-between"><span>'+para(x.para)+' '+esc(x.text)+'</span>'+(E()?'<button class="btn sm" data-act="vfix" data-id="'+v.id+'" data-fix="'+x.fix+'">'+esc(x.fixL)+'</button>':'')+'</div></div>';}).join('')+'</div>':'<div class="callout good" style="margin-top:14px">'+(v.critical?'All mandatory artefacts on file.':'Outside critical processes; ¶19(c) assurance not required.')+'</div>';
  if(v.docs&&v.docs.length)h+='<h3 style="margin:16px 0 6px">Documents on file</h3><div class="tbl-w"><table class="tbl"><tbody>'+v.docs.slice().reverse().map(function(x){return '<tr><td><div class="small">'+esc(x.name)+'</div><div class="hash">'+fD(x.at)+' · '+short(x.hash)+dlLink(x)+'</div></td></tr>';}).join('')+'</tbody></table></div>';
  h+='<div style="margin-top:16px"><h3>Readiness request to the vendor</h3><p class="small muted" style="margin:4px 0 8px">Send this to the vendor so they can supply what ¶5 requires them to evidence.</p><pre class="draft" id="invite">'+esc(invite(v))+'</pre><button class="btn sm" style="margin-top:8px" data-act="copyInvite">Copy request</button></div></div></section>';
  return h;
}
function invite(v){
  var g=vendorGaps(v);
  return 'Subject: Evidence needed under RBI Master Directions (5 Nov 2026), para 5\n\nHello '+v.name+' team,\n\n'+S.entity+' is required to ensure that entities in its payment ecosystem adhere to the RBI Master Directions on Cyber Resilience and Digital Payment Security Controls. Our records for your service ('+lc(v.service)+') show:\n'+
    (g.length?g.map(function(x){return '- '+x.para+': '+x.text;}).join('\n'):'- No open items. Please confirm your evidence remains current.')+
    '\n\nPlease send the artefacts within 15 working days. Each file is hashed when we record it so our system auditor can rely on it.\n\nRegards,\n'+(S.contact||S.me.name);
}

/* ---------- Board ---------- */
function vBoard(){
  var r=readiness(),f=filingStats(),t=now(),ind=independence(),crit=S.vendors.filter(function(v){return v.critical;}),clear=crit.filter(function(v){return vendorState(v)[1]==='good';});
  var pd=S.obs.filter(function(o){return o.status!=='closed'&&obsDue(o)<t;}).length,bi=boardItems(),od=bi.filter(function(b){return b.state[1]==='bad';}).length,pend=S.board.reports.filter(function(x){return !x.placed;});
  var h='<div class="ph"><div><div class="eyebrow">Paras 11, 12, 20(f), 23, 26(c)</div><h1>Board Pack</h1><p class="lede">Key risk indicators computed from live evidence, the resilience tests the Directions put on a calendar, and the IT assessment reports that must reach the Board sub-committee at its next meeting.</p></div>'+
    '<div class="fld"><label class="f" for="mtg">Next Board IT oversight sub-committee meeting</label><input class="in" type="date" id="mtg" data-set="meeting" value="'+(S.board.meeting?dateInput(S.board.meeting):'')+'"'+(E()?'':' disabled')+'></div></div>';
  var K=[['Control readiness across ¶38 areas',r.avg+'%',r.avg>=85?'good':r.avg>=60?'warn':'bad','85% or higher'],['Observations past the ¶41 three-month limit',String(pd),pd?'bad':'good','0'],['Incident reports filed within six hours (¶22(d))',f.ok+' of '+f.n,f.ok===f.n?'good':'bad','All'],['Critical vendors with complete evidence',clear.length+' of '+crit.length,clear.length===crit.length?'good':'warn','All'],['Resilience tests overdue (¶20(f), ¶23)',String(od),od?'bad':'good','0'],['Proposed system auditor independent (¶37)',!ind.a?'Not set':ind.conflicts.length?'No':'Yes',ind.a&&!ind.conflicts.length?'good':'bad','Yes'],['IT assessment reports awaiting the sub-committee (¶12)',String(pend.length),pend.length?'warn':'good','Placed at next meeting']];
  h+='<section class="grid2"><div class="card"><div class="card-h"><h2>Key risk indicators</h2>'+para('¶11')+'</div><div class="tbl-w"><table class="tbl"><thead><tr><th>Indicator</th><th class="r">Now</th><th class="r">Tolerance</th></tr></thead><tbody>'+K.map(function(k){return '<tr><td>'+esc(k[0])+'</td><td class="r"><span class="score" style="color:var(--'+k[2]+')">'+esc(k[1])+'</span></td><td class="r small muted">'+esc(k[3])+'</td></tr>';}).join('')+'</tbody></table></div></div>';
  h+='<div class="card"><div class="card-h"><h2>Resilience calendar</h2></div><div class="tbl-w"><table class="tbl"><thead><tr><th>Test</th><th>Last done</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>'+bi.map(function(b){return '<tr><td>'+esc(b.label)+' '+para(b.para)+'<div class="small muted">'+b.cad+'</div></td><td class="small num">'+fD(b.last)+'</td><td class="small num">'+fD(b.due)+'</td><td>'+chip(b.state[0],b.state[1])+'</td><td class="r">'+(E()?'<button class="btn sm" data-act="boardDone" data-k="'+b.k+'">Record today</button>':'')+'</td></tr>';}).join('')+'</tbody></table></div>'+
    '<div class="card-h" style="margin:16px 0 6px"><h3>Reports for the next meeting '+para('¶12')+'</h3>'+(E()?'<button class="btn sm" data-act="addReport">Add report</button>':'')+'</div><div class="tbl-w"><table class="tbl"><tbody>'+(S.board.reports.length?S.board.reports.map(function(x){return '<tr><td><div>'+esc(x.name)+'</div><div class="small muted">'+esc(x.by)+' · received '+fD(x.received)+'</div></td><td class="r">'+(x.placed?chip('Placed','good'):(E()?'<button class="btn sm" data-act="placed" data-id="'+x.id+'">Mark placed</button>':chip('Pending','warn')))+'</td></tr>';}).join(''):'<tr><td><div class="empty">No IT assessment reports recorded.</div></td></tr>')+'</tbody></table></div></div></section>';
  h+='<section class="card"><div class="card-h"><h2>Note for the sub-committee</h2><div class="row"><button class="btn" data-act="copyNote">Copy note</button><button class="btn primary" data-act="dlNote">Download .md</button></div></div><pre class="draft">'+esc(boardNote())+'</pre></section>';
  return h;
}

/* ---------- Activity log ---------- */
function vActivity(){
  var h='<div class="ph"><div><div class="eyebrow">Tamper-evident record</div><h1>Activity log</h1><p class="lede">Every change in this workspace, in order. Each entry is hashed together with the one before it, so editing or deleting any entry breaks the chain from that point on. The auditor evidence ZIP carries the full log so anyone can re-verify it.</p></div><div class="verify"><button class="btn primary" data-act="verify">Verify the chain</button></div></div>';
  if(ui.verify)h+='<div class="callout '+(ui.verify.ok?'good':'bad')+'">'+(ui.verify.ok?'<b>Chain intact.</b> '+ui.verify.entries+' entries verified; head hash <span class="mono">'+esc(ui.verify.head.slice(0,16))+'…</span>':'<b>Chain broken at entry '+ui.verify.firstBad+'.</b> Entries from that point cannot be relied on.')+'</div>';
  if(!ui.activity){loadActivity();return h+'<div class="empty">Loading…</div>';}
  return h+'<section class="card"><div class="tbl-w"><table class="tbl"><thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>Hash</th></tr></thead><tbody>'+ui.activity.map(function(e){return '<tr><td class="mono">'+e.seq+'</td><td class="small num">'+fDT(e.at)+'</td><td class="small">'+esc(e.actor)+'</td><td class="mono">'+esc(e.action)+'</td><td class="small">'+esc(describe(e.detail))+'</td><td class="hash">'+esc(e.hash.slice(0,12))+'…</td></tr>';}).join('')+'</tbody></table></div><p class="small muted" style="margin:10px 0 0">Showing the latest '+ui.activity.length+' entries.</p></section>';
}
function describe(d){return Object.keys(d||{}).filter(function(k){return d[k]!==null&&d[k]!==''&&k!=='evidence_id';}).map(function(k){var v=d[k];if(k==='sha256'&&v)v=String(v).slice(0,12)+'…';if(typeof v==='object')v=JSON.stringify(v);return k.replace(/_/g,' ')+': '+v;}).join(' · ');}
function loadActivity(){api('GET','/api/activity?limit=300').then(function(j){ui.activity=j.entries;if(ui.view==='activity')render();},function(e){toast(e.message);});}

/* ---------- Team ---------- */
function vTeam(){
  var h='<div class="ph"><div><div class="eyebrow">Access</div><h1>Team</h1><p class="lede">Compliance staff collect and submit evidence. The system auditor reviews it and is the only role that can mark evidence as relied on or accept an observation\'s closure. Board members see everything and change nothing.</p></div>'+(ADMIN()?'<button class="btn primary" data-act="addUser">Add a person</button>':'')+'</div>';
  if(!ui.users){api('GET','/api/users').then(function(j){ui.users=j.users;if(ui.view==='team')render();},function(e){toast(e.message);});return h+'<div class="empty">Loading…</div>';}
  return h+'<section class="card"><div class="tbl-w"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>'+ui.users.map(function(u){var self=u.email===S.me.email;
    var roleCell=ADMIN()&&!self?'<select class="in" data-urole="'+u.id+'" aria-label="Role for '+esc(u.name)+'">'+['admin','compliance','auditor','viewer'].map(function(r){return '<option value="'+r+'"'+(u.role===r?' selected':'')+'>'+ROLE_LABEL[r]+'</option>';}).join('')+'</select>':esc(ROLE_LABEL[u.role]||u.role);
    return '<tr><td>'+esc(u.name)+(self?' <span class="small muted">(you)</span>':'')+'</td><td class="mono">'+esc(u.email)+'</td><td>'+roleCell+'</td><td class="small num">'+(u.lastLogin?fDT(u.lastLogin):'Never')+'</td><td class="r">'+(ADMIN()&&!self?'<button class="btn sm'+(u.active?' danger':'')+'" data-act="userActive" data-id="'+u.id+'" data-v="'+(u.active?'0':'1')+'">'+(u.active?'Remove access':'Restore access')+'</button>':(u.active?'':chip('No access','mute')))+'</td></tr>';}).join('')+'</tbody></table></div></section>';
}

/* ---------- Pricing ---------- */
function vPricing(){
  var p=S.pricing,x=roi();
  var h='<div class="ph"><div><div class="eyebrow">Priced against the audit, not the transaction</div><h1>Pricing and ROI</h1><p class="lede">Every number below reads as a discount to audit hours and compliance headcount. Change any assumption to match the prospect; the figures recalculate and are saved to this workspace.</p></div></div>';
  if(S.payUrl)h+='<div class="callout">Ready to buy? Pay the amount on your quote through Razorpay: <a href="'+esc(S.payUrl)+'" target="_blank" rel="noopener">'+esc(S.payUrl.replace(/^https?:\/\//,''))+'</a>. It opens in a new tab.</div>';
  h+='<section class="tiers">'+tier('Small PSO','₹2.4 lakh','per year, flat','Audit Room and Board Pack for small PPI issuers and instant money transfer operators; live from 1 Apr 2028.',['Referral channel through empanelled auditors','Resale only by a firm that does not audit that client (¶37)','Self-serve onboarding'],false)+
    tier('Medium PSO',lakh(x.price),'per year at the current assumptions','The full package for MTSS operators and medium PPI issuers, timed to their first SAR under the consolidated scope.',['All 20 ¶38 control areas','Six-Hour Desk with RBI and CERT-In drafts','Vendor Flow-down for '+x.crit+' critical vendors'],true)+
    tier('Large PSO','From ₹45 lakh','per year','Card networks, payment aggregators, white-label ATM operators and large PPI issuers absorbing audit observations now.',['Per-control-area and per-vendor pricing','SIEM and ITSM evidence connectors','Auditor access with reliance recorded'],false)+
    tier('Vendor workspace','₹36,000','per vendor per year, billed to the vendor','Self-serve readiness for gateways, service providers and vendors that ¶5 brings into scope.',['Evidence file the PSO can rely on','One workspace serves many PSO customers','No competition with the PSO sale'],false)+'</section>';
  var F=[['platform','Platform fee (₹/yr)'],['perArea','Per applicable control area (₹/yr)'],['perVendor','Per critical vendor (₹/yr)'],['desk','Six-Hour Desk add-on (₹/yr)'],['audHrs','Auditor hours per area on evidence and re-testing'],['audRate','Auditor blended rate (₹/hr)'],['audCut','Share of that auditor work removed (%)'],['intHrs','Internal hours per area per audit cycle'],['intRate','Internal cost (₹/hr)'],['intCut','Share of internal effort removed (%)'],['filings','Incident filings per year'],['asmManual','Assembly hours per filing today'],['asmTool','Assembly hours per filing with Sakshya'],['team','People on each filing'],['vendorHrs','Hours chasing each critical vendor per year']];
  h+='<section class="roi"><div class="card"><div class="card-h"><h2>Assumptions</h2><span class="small muted">'+x.areas+' applicable areas · '+x.crit+' critical vendors</span></div><div class="fgrid">'+F.map(function(f){return '<div class="fld"><label class="f" for="p-'+f[0]+'">'+f[1]+'</label><input class="in num" type="number" min="0" id="p-'+f[0]+'" data-price="'+f[0]+'" value="'+p[f[0]]+'"'+(E()?'':' disabled')+'></div>';}).join('')+'</div></div><div class="card" id="roi-out">'+roiOut()+'</div></section>';
  h+='<section class="card"><div class="card-h"><h2>What the subscription covers</h2><span class="small muted">Clause to module</span></div><div class="tbl-w"><table class="tbl"><thead><tr><th>Para</th><th>Obligation</th><th>Module</th><th>Coverage</th></tr></thead><tbody>'+[
    ['36, 38','Annual system audit, TOD and TOE across the listed control areas, filed within two months of year end','Audit Room','Covered','good'],
    ['37','Auditor and sister concerns barred if they served the entity in the last two years','Audit Room','Covered','good'],
    ['39–41','Prior observations tracked; corrective action within three months','Audit Room','Covered','good'],
    ['22(d)','Unusual incidents to RBI within six hours of detection; cyber incidents to CERT-In','Six-Hour Desk','Covered; Annex 1 columns mapped at onboarding','good'],
    ['5, 19(c)','Ecosystem adherence by agreement; independent assurance on critical vendors','Vendor Flow-down','Covered','good'],
    ['17(c), 18(b)','Source code or escrow for critical procured apps; developer certificate per change','Vendor Flow-down','Covered','good'],
    ['26(c)','Annual independent CSP audit reviewed by the Board sub-committee','Vendor Flow-down','Covered','good'],
    ['11, 12','KRIs monitored by the Board sub-committee; IT assessment reports placed at the next meeting','Board Pack','Covered','good'],
    ['20(f), 23','Half-yearly backup restore tests and DR drills; annual BCP review','Board Pack','Covered','good'],
    ['27(c)','Real-time fraud monitoring with alerts','Not in this product','Ingests its alerts as evidence; scoring is a separate engagement','mute']
  ].map(function(r){return '<tr><td class="mono">¶'+r[0]+'</td><td class="small">'+r[1]+'</td><td>'+r[2]+'</td><td>'+chip(r[3],r[4])+'</td></tr>';}).join('')+'</tbody></table></div></section>';
  return h;
}
function tier(n,p,u,d,li,hl){return '<div class="tier'+(hl?' hl':'')+'"><div class="eyebrow">'+esc(n)+'</div><div class="pr">'+esc(p)+'</div><div class="small muted">'+esc(u)+'</div><p class="small" style="margin:0">'+esc(d)+'</p><ul>'+li.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>'+(S.payUrl?'<a class="btn'+(hl?' primary':'')+'" href="'+esc(S.payUrl)+'" target="_blank" rel="noopener">Pay online</a>':'')+'</div>';}
function roiOut(){
  var x=roi(),mx=Math.max(x.price,x.save,1);
  return '<div class="card-h"><h2>Annual effect for this prospect</h2></div><div class="split2"><div class="stat"><div class="v">'+lakh(x.save)+'</div><div class="l">Cost removed per year</div></div><div class="stat"><div class="v" style="color:var(--'+(x.net>=0?'good':'bad')+')">'+(x.net>=0?'':'−')+lakh(Math.abs(x.net))+'</div><div class="l">Net of the subscription · payback '+(x.payback?x.payback.toFixed(1)+' months':'n/a')+'</div></div></div>'+
    '<div class="cmp" style="margin-top:16px"><div class="small muted">Subscription</div><div class="bar" style="width:'+(x.price/mx*100)+'%;background:var(--accent)">'+inr(x.price)+'</div><div class="small muted">Cost removed</div><div class="bar" style="width:'+(x.save/mx*100)+'%;background:var(--good)">'+inr(x.save)+'</div></div>'+
    '<div class="tbl-w" style="margin-top:14px"><table class="tbl"><tbody><tr><td>Auditor evidence and re-testing hours</td><td class="r">'+inr(x.audit)+'</td></tr><tr><td>Internal audit-cycle effort</td><td class="r">'+inr(x.internal)+'</td></tr><tr><td>Six-hour filing assembly</td><td class="r">'+inr(x.filing)+'</td></tr><tr><td>Vendor evidence chasing</td><td class="r">'+inr(x.vendor)+'</td></tr></tbody></table></div>'+
    '<div class="callout" style="margin-top:12px">Per control area: Sakshya costs <b>'+inr(x.perArea)+'</b> all-in; the audit work it removes is worth <b>'+inr(x.savePerArea)+'</b>. Auditor savings land at the next fee negotiation, so lead with the internal and filing lines.</div>';
}

/* ---------- clock ---------- */
function tick(){
  var t=now();
  Array.prototype.forEach.call(document.querySelectorAll('[data-deadline]'),function(el){
    var rem=+el.getAttribute('data-deadline')-t,state=rem<=0?'over':rem<HOUR?'crit':rem<3*HOUR?'warn':'ok';
    if(el.getAttribute('data-fmt')==='chip'){el.className='chip '+(state==='ok'?'accent':state==='warn'?'warn':'bad');el.textContent=rem>0?hms(rem)+' left':'Overdue '+dur(-rem);}
    else{el.textContent=(rem<0?'−':'')+hms(rem);el.setAttribute('data-state',state);}
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-pfrom]'),function(el){var a=+el.getAttribute('data-pfrom'),b=+el.getAttribute('data-pto'),p=Math.max(0,Math.min(1,(t-a)/(b-a)));el.style.width=(p*100)+'%';el.style.background=p>=1||b-t<HOUR?'#ff8a7d':b-t<3*HOUR?'#ffc35c':'#8f95ff';});
}

/* ---------- dialogs and feedback ---------- */
function toast(m){var r=document.getElementById('toast-root');r.innerHTML='<div class="toast" role="status">'+esc(m)+'</div>';clearTimeout(toast._t);toast._t=setTimeout(function(){r.innerHTML='';},3600);}
function openDlg(title,bodyHtml,submitLabel,handler){
  dlgHandler=handler;
  document.getElementById('dlg-root').innerHTML='<div class="scrim" data-act="closeDlgBg"><form class="dlg" id="dlg-form" role="dialog" aria-modal="true" aria-label="'+esc(title)+'"><h2>'+esc(title)+'</h2>'+bodyHtml+'<div class="err" id="dlg-err"></div><div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-act="closeDlg">Cancel</button><button type="submit" class="btn primary" id="dlg-ok">'+esc(submitLabel)+'</button></div></form></div>';
  var f=document.querySelector('#dlg-form input:not([type=hidden]),#dlg-form select,#dlg-form textarea');if(f)f.focus();
}
function closeDlg(){document.getElementById('dlg-root').innerHTML='';dlgHandler=null;}
function dlgErr(m){var e=document.getElementById('dlg-err');if(e)e.textContent=m;var b=document.getElementById('dlg-ok');if(b)b.disabled=false;}
function fval(id){var e=document.getElementById(id);return e?e.value:'';}
function fchk(id){var e=document.getElementById(id);return !!(e&&e.checked);}
function submitDlg(promise){var b=document.getElementById('dlg-ok');if(b)b.disabled=true;return promise.then(function(j){closeDlg();return j;},function(e){dlgErr(e.message);});}
function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){toast('Copied to clipboard');},function(){fallbackCopy(text);});}else fallbackCopy(text);}
function fallbackCopy(text){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);toast(ok?'Copied to clipboard':'Copy was blocked; select the text and copy it manually');}
function download(name,text,type){var blob=new Blob([text],{type:type||'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(url);a.remove();},500);}

/* ---------- actions ---------- */
var A={
  go:function(el){if(el.dataset.inc)ui.inc=el.dataset.inc;if(el.dataset.area)ui.area=el.dataset.area;if(el.dataset.vendor)ui.vendor=el.dataset.vendor;},
  area:function(el){ui.area=el.dataset.id;render();var d=document.getElementById('area-detail');if(d&&window.innerWidth<960)d.scrollIntoView({block:'start'});},
  evStatus:function(el){mut('POST','/api/evidence/'+el.dataset.id+'/status',{status:el.dataset.to},el.dataset.to==='accepted'?'Recorded as relied on':null);},
  addEv:function(el){
    var a=areaById(el.dataset.id),kind=el.dataset.kind,fy=fyOf(now(),S.fyType),ps=periodsFor(fy,a.cad).filter(function(p){return p.start<=now();});
    var body='<p class="small muted" style="margin:0">'+esc(a.name)+'. The file is stored with its SHA-256 hash, your name and the server time. It can be superseded but never edited or deleted.</p>'+
      '<div class="fgrid"><div class="fld"><label class="f" for="d-kind">Evidence type</label><select class="in" id="d-kind"><option value="tod"'+(kind==='tod'?' selected':'')+'>Design (TOD)</option><option value="toe"'+(kind==='toe'?' selected':'')+'>Operating (TOE)</option></select></div>'+
      '<div class="fld"><label class="f" for="d-per">Period (operating only)</label><select class="in" id="d-per">'+ps.map(function(p){return '<option value="'+esc(p.key)+'"'+(el.dataset.period===p.key?' selected':'')+'>'+esc(p.label)+'</option>';}).join('')+'</select></div></div>'+
      '<div class="fld"><label class="f" for="d-file">File</label><input class="in" type="file" id="d-file"></div>'+
      '<div class="fld"><label class="f" for="d-name">Artefact name</label><input class="in" id="d-name" placeholder="Defaults to the file name"></div>'+
      '<div class="fld"><label class="f" for="d-src">Source system</label><input class="in" id="d-src" value="'+(kind==='toe'?esc(a.toeSource):'Policy library')+'"></div>';
    openDlg('Add evidence',body,'Upload and hash',function(){
      var fd=new FormData(),file=document.getElementById('d-file').files[0];
      if(!file&&!fval('d-name').trim()){dlgErr('Choose a file or enter an artefact name.');return;}
      fd.append('area',a.id);fd.append('kind',fval('d-kind'));fd.append('period',fval('d-per'));fd.append('name',fval('d-name'));fd.append('source',fval('d-src'));if(file)fd.append('file',file);
      submitDlg(mut('POST','/api/evidence',fd,function(j){return j.sha256?'Stored · SHA-256 '+j.sha256.slice(0,12)+'…':'Recorded without a file';}));
    });
  },
  obsFilter:function(el){ui.obsFilter=el.dataset.v;render();},
  obsTo:function(el){mut('POST','/api/observations/'+encodeURIComponent(el.dataset.id)+'/status',{status:el.dataset.to});},
  addObs:function(){
    var body='<div class="fld"><label class="f" for="o-t">Observation</label><input class="in" id="o-t"></div><div class="fgrid"><div class="fld"><label class="f" for="o-a">Control area</label><select class="in" id="o-a">'+S.areas.map(function(a){return '<option value="'+a.id+'">'+esc(a.name)+'</option>';}).join('')+'</select></div><div class="fld"><label class="f" for="o-s">Severity</label><select class="in" id="o-s"><option>High</option><option selected>Medium</option><option>Low</option></select></div><div class="fld"><label class="f" for="o-r">Raised on</label><input class="in" type="date" id="o-r" value="'+dateInput(now())+'"></div><div class="fld"><label class="f" for="o-src">Source</label><input class="in" id="o-src" value="System audit"></div></div>';
    openDlg('Log an audit observation',body,'Log observation',function(){
      var r=Date.parse(fval('o-r')+'T09:00');if(!fval('o-t').trim()){dlgErr('Describe the observation.');return;}if(isNaN(r)){dlgErr('Enter the date it was raised.');return;}
      ui.obsFilter='open';submitDlg(mut('POST','/api/observations',{title:fval('o-t'),area:fval('o-a'),sev:fval('o-s'),raised:r,source:fval('o-src')}));
    });
  },
  addAuditor:function(){
    openDlg('Add an auditor firm','<div class="fld"><label class="f" for="a-n">Firm</label><input class="in" id="a-n"></div><div class="fld"><label class="f" for="a-b">Qualification (¶36)</label><select class="in" id="a-b"><option>CERT-In empanelled</option><option>CISA-certified (ISACA)</option><option>DISA (ICAI)</option></select></div><div class="fld"><label class="f" for="a-s">Sister concerns, one per line</label><textarea class="in" id="a-s" rows="3"></textarea></div>','Add firm',function(){
      if(!fval('a-n').trim()){dlgErr("Enter the firm's name.");return;}
      submitDlg(mut('POST','/api/auditors',{name:fval('a-n'),basis:fval('a-b'),sisters:fval('a-s').split('\n')}));
    });
  },
  addSvc:function(){
    var cur=fyOf(now(),S.fyType).sy,opts='';for(var y=cur;y>=cur-4;y--)opts+='<option value="'+y+'">'+fyLabel(y,S.fyType)+'</option>';
    openDlg('Add to the services ledger','<p class="small muted" style="margin:0">Record every firm that served the entity, so the ¶37 check can see it.</p><div class="fld"><label class="f" for="s-p">Provider</label><input class="in" id="s-p"></div><div class="fgrid"><div class="fld"><label class="f" for="s-s">Service</label><input class="in" id="s-s"></div><div class="fld"><label class="f" for="s-y">Year</label><select class="in" id="s-y">'+opts+'</select></div></div>','Add',function(){
      if(!fval('s-p').trim()){dlgErr('Enter the provider name.');return;}
      submitDlg(mut('POST','/api/services',{provider:fval('s-p'),service:fval('s-s'),fy:+fval('s-y')}));
    });
  },
  delSvc:function(el){mut('DELETE','/api/services/'+el.dataset.id);},
  inc:function(el){ui.inc=el.dataset.id;render();},
  newInc:function(){
    var body='<div class="fld"><label class="f" for="n-t">What happened</label><input class="in" id="n-t" placeholder="e.g. Settlement file to sponsor bank delayed"></div><div class="fgrid"><div class="fld"><label class="f" for="n-c">Category (¶22(d))</label><select class="in" id="n-c">'+CATS.map(function(c){return '<option>'+c+'</option>';}).join('')+'</select></div><div class="fld"><label class="f" for="n-d">Detected at</label><input class="in" type="datetime-local" id="n-d" value="'+localInput(now())+'" max="'+localInput(now()+MIN)+'"></div></div>'+
      '<div class="fld"><label class="f" for="n-s">Systems or services affected</label><input class="in" id="n-s"></div><label class="check"><input type="checkbox" id="n-cy" checked> Cyber security incident (also report to CERT-In)</label>'+
      '<div class="fld"><label class="f" for="n-l">Log lines (optional)</label><textarea class="in" id="n-l" rows="4" placeholder="[WAF] 2026-11-18T09:41:07+05:30 blocked 1,204 requests from 203.0.113.9"></textarea></div><p class="small muted" style="margin:0">The detection time is locked once the incident is opened; the six-hour clock runs from it.</p>';
    openDlg('Open an incident',body,'Open and start the clock',function(){
      var d=Date.parse(fval('n-d'));
      if(!fval('n-t').trim()){dlgErr('Describe what happened.');return;}if(isNaN(d)){dlgErr('Enter the detection time.');return;}if(d>now()+MIN){dlgErr('Detection time cannot be in the future.');return;}
      submitDlg(mut('POST','/api/incidents',{title:fval('n-t'),cat:fval('n-c'),cyber:fchk('n-cy'),detected:d,systems:fval('n-s'),logs:fval('n-l')},null,true).then(function(j){ui.inc=j.ref;if(location.hash!=='#six-hour')location.hash='six-hour';else render();}));
    });
    var cat=document.getElementById('n-c');cat.addEventListener('change',function(){document.getElementById('n-cy').checked=cat.value==='Cyber attack';});
  },
  addLogs:function(el){
    var id=el.dataset.id;
    openDlg('Paste log lines','<p class="small muted" style="margin:0">One event per line. A leading [SOURCE] tag, an ISO timestamp and IPv4 addresses are read automatically; lines without a timestamp take the detection time.</p><textarea class="in" id="l-t" rows="9" placeholder="[AUTH] 2026-11-18T10:02:13+05:30 failed login burst from 198.51.100.7"></textarea>','Add to evidence',function(){
      if(!fval('l-t').trim()){dlgErr('Paste at least one line.');return;}
      submitDlg(mut('POST','/api/incidents/'+encodeURIComponent(id)+'/events',{logs:fval('l-t')},function(j){return j.count+' event'+(j.count>1?'s':'')+' added';}));
    });
  },
  ms:function(el){var id=el.dataset.id,k=el.dataset.k;mut('POST','/api/incidents/'+encodeURIComponent(id)+'/milestone',{key:k},function(){var i=incById(id);if(k==='rbi'&&i&&i.ms.rbi){var d=i.ms.rbi-i.detected;return 'Filed '+dur(d)+' after detection'+(d>6*HOUR?' · outside the six-hour window':'');}return null;});},
  tab:function(el){ui.tab=el.dataset.v;Array.prototype.forEach.call(document.querySelectorAll('.tabs button[data-act="tab"]'),function(b){b.classList.toggle('on',b.dataset.v===ui.tab);});refreshDraft(incById(ui.inc));},
  resetNarr:function(el){mut('PATCH','/api/incidents/'+encodeURIComponent(el.dataset.id),{narrative:''});},
  polish:function(el){ui.busy='polish';render();mut('POST','/api/incidents/'+encodeURIComponent(el.dataset.id)+'/narrative',{},'Description drafted by Claude. Check every fact before filing.',true).then(function(){ui.busy=null;render();},function(){ui.busy=null;render();});},
  copyDraft:function(el){var i=incById(el.dataset.id);copyText(ui.tab==='rbi'?draftRBI(i):draftCERT(i));},
  dlDraft:function(el){var i=incById(el.dataset.id);download(i.id+'-'+(ui.tab==='rbi'?'RBI':'CERT-In')+'-draft.txt',ui.tab==='rbi'?draftRBI(i):draftCERT(i));},
  vendor:function(el){ui.vendor=el.dataset.id;render();},
  vfix:function(el){
    var v=S.vendors.filter(function(x){return x.id===el.dataset.id;})[0],fix=el.dataset.fix;
    if(['agreement','escrow','cspboard','codechange'].indexOf(fix)>=0){var fd=new FormData();fd.append('fix',fix);mut('POST','/api/vendors/'+v.id+'/fix',fd,{agreement:'Agreement recorded',escrow:'Escrow arrangement recorded',cspboard:'Board sub-committee review recorded',codechange:'Code change recorded; a fresh developer certificate is now due'}[fix]);return;}
    var title={assurance:'Upload assurance report',devcert:'Upload developer certificate',cspaudit:'Upload CSP audit report'}[fix];
    var body='<p class="small muted" style="margin:0">'+esc(v.name)+'. The file is stored with its SHA-256 hash.</p><div class="fld"><label class="f" for="u-f">File</label><input class="in" type="file" id="u-f"></div><div class="fld"><label class="f" for="u-d">'+(fix==='assurance'?'Valid until':'Dated')+'</label><input class="in" type="date" id="u-d" value="'+dateInput(fix==='assurance'?addM(now(),12):now())+'"></div>';
    openDlg(title,body,'Upload and record',function(){
      var d=Date.parse(fval('u-d')+'T12:00');if(isNaN(d)){dlgErr('Enter a date.');return;}
      var fd=new FormData(),file=document.getElementById('u-f').files[0];fd.append('fix',fix);fd.append('date',String(d));if(file)fd.append('file',file);
      submitDlg(mut('POST','/api/vendors/'+v.id+'/fix',fd,'Recorded'));
    });
  },
  addVendor:function(){
    var body='<div class="fgrid"><div class="fld"><label class="f" for="v-n">Vendor</label><input class="in" id="v-n"></div><div class="fld"><label class="f" for="v-s">Service</label><input class="in" id="v-s"></div></div><label class="check"><input type="checkbox" id="v-c" checked> Supports a critical process (¶19(c))</label><label class="check"><input type="checkbox" id="v-p"> Procured application (¶17(c), ¶18(b))</label><label class="check"><input type="checkbox" id="v-cl"> Cloud service provider (¶26(c))</label>';
    openDlg('Add vendor',body,'Add vendor',function(){
      if(!fval('v-n').trim()){dlgErr('Enter the vendor name.');return;}
      submitDlg(mut('POST','/api/vendors',{name:fval('v-n'),service:fval('v-s'),critical:fchk('v-c'),procured:fchk('v-p'),cloud:fchk('v-cl')},null,true).then(function(j){ui.vendor=j.id;render();}));
    });
  },
  copyInvite:function(){var e=document.getElementById('invite');if(e)copyText(e.textContent);},
  boardDone:function(el){mut('POST','/api/board/test',{k:el.dataset.k},'Recorded today');},
  addReport:function(){
    openDlg('Add an IT assessment report','<p class="small muted" style="margin:0">¶12: every IT assessment report, including VA and PT output, goes to the Board sub-committee at its next meeting.</p><div class="fld"><label class="f" for="r-n">Report</label><input class="in" id="r-n"></div><div class="fgrid"><div class="fld"><label class="f" for="r-b">Prepared by</label><input class="in" id="r-b"></div><div class="fld"><label class="f" for="r-d">Received on</label><input class="in" type="date" id="r-d" value="'+dateInput(now())+'"></div></div>','Add report',function(){
      var d=Date.parse(fval('r-d')+'T12:00');if(!fval('r-n').trim()||isNaN(d)){dlgErr('Enter the report name and the date received.');return;}
      submitDlg(mut('POST','/api/board/reports',{name:fval('r-n'),by:fval('r-b'),received:d}));
    });
  },
  placed:function(el){mut('POST','/api/board/reports/'+el.dataset.id+'/placed');},
  copyNote:function(){copyText(boardNote());},
  dlNote:function(){download('board-subcommittee-note-'+dateInput(S.board.meeting||now())+'.md',boardNote(),'text/markdown');},
  verify:function(){api('GET','/api/activity/verify').then(function(j){ui.verify=j;ui.activity=null;render();},function(e){toast(e.message);});},
  addUser:function(){
    openDlg('Add a person','<div class="fgrid"><div class="fld"><label class="f" for="u-n">Name</label><input class="in" id="u-n"></div><div class="fld"><label class="f" for="u-e">Email</label><input class="in" type="email" id="u-e"></div></div><div class="fgrid"><div class="fld"><label class="f" for="u-r">Role</label><select class="in" id="u-r"><option value="compliance">Compliance</option><option value="auditor">System auditor</option><option value="viewer">Board / viewer</option><option value="admin">Administrator</option></select></div><div class="fld"><label class="f" for="u-p">Temporary password</label><input class="in" id="u-p" minlength="10"></div></div><p class="small muted" style="margin:0">Share the temporary password through a separate channel.</p>','Add person',function(){
      submitDlg(api('POST','/api/users',{name:fval('u-n'),email:fval('u-e'),role:fval('u-r'),password:fval('u-p')}).then(function(j){ui.users=j.users;render();toast('Added');}));
    });
  },
  userActive:function(el){api('POST','/api/users/'+el.dataset.id,{active:el.dataset.v==='1'}).then(function(j){ui.users=j.users;render();},function(e){toast(e.message);});},
  reset:function(){if(!ui.resetArm){ui.resetArm=true;shell();setTimeout(function(){ui.resetArm=false;if(S)shell();},4000);return;}ui.resetArm=false;ui.area=ui.inc=ui.vendor=null;ui.activity=null;mut('POST','/api/demo/reset',{},'Demo data reset');},
  closeDlg:function(){closeDlg();},
  closeDlgBg:function(el,e){if(e.target===el)closeDlg();}
};
function refreshDraft(i){var p=document.getElementById('draft-pre');if(p&&i)p.textContent=ui.tab==='rbi'?draftRBI(i):draftCERT(i);}

/* ---------- events ---------- */
document.addEventListener('click',function(e){
  var el=e.target.closest('[data-act]');if(!el)return;
  var a=el.dataset.act;if(!A[a]||a==='applicable')return;
  if(a==='closeDlgBg'){A[a](el,e);return;}
  if(a!=='go')e.preventDefault();
  A[a](el,e);
  if(a==='go'){var h=el.getAttribute('href').slice(1);if(location.hash==='#'+h){route();render();}}
});
document.addEventListener('change',function(e){
  var el=e.target;
  if(el.dataset.act==='applicable'){mut('POST','/api/areas/'+el.dataset.id+'/applicable',{applicable:el.checked});return;}
  if(el.dataset.urole){api('POST','/api/users/'+el.dataset.urole,{role:el.value}).then(function(j){ui.users=j.users;toast('Role updated');},function(err){toast(err.message);render();});return;}
  if(el.dataset.price){mut('POST','/api/settings',{pricing:S.pricing},null,true);return;}
  if(el.dataset.inc){
    var i=incById(ui.inc);if(!i)return;var f=el.dataset.inc,payload={};
    if(f==='cyber'){mut('PATCH','/api/incidents/'+encodeURIComponent(i.id),{cyber:el.checked});return;}
    if(f.indexOf('impact.')===0){payload.impact={};payload.impact[f.slice(7)]=+el.value||0;}else payload[f]=el.value;
    api('PATCH','/api/incidents/'+encodeURIComponent(i.id),payload).then(function(j){var keepTab=ui.tab;S=j.state;ui.tab=keepTab;refreshDraft(incById(ui.inc));},function(err){toast(err.message);});
    return;
  }
  var k=el.dataset.set;if(!k)return;
  if(k==='segment')mut('POST','/api/settings',{segment:el.value});
  else if(k==='fyType')mut('POST','/api/settings',{fyType:el.value},'Financial year updated');
  else if(k==='auditor'){if(el.value)mut('POST','/api/settings',{auditor:el.value});}
  else if(k==='meeting'){var d=Date.parse(el.value+'T10:00');if(!isNaN(d))mut('POST','/api/settings',{meeting:d});}
});
document.addEventListener('input',function(e){
  var el=e.target;
  if(el.dataset.price){S.pricing[el.dataset.price]=Math.max(0,+el.value||0);var o=document.getElementById('roi-out');if(o)o.innerHTML=roiOut();return;}
  var f=el.dataset.inc;if(!f||f==='cyber')return;
  var i=incById(ui.inc);if(!i)return;
  if(f.indexOf('impact.')===0)i.impact[f.slice(7)]=Math.max(0,+el.value||0);else i[f]=el.value;
  refreshDraft(i);
});
document.addEventListener('submit',function(e){
  if(e.target.id!=='dlg-form')return;e.preventDefault();
  if(dlgHandler){try{dlgHandler();}catch(err){dlgErr('Something went wrong; try again.');}}
});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&dlgHandler)closeDlg();});
window.addEventListener('hashchange',function(){route();if(ui.view==='activity')ui.activity=null;if(ui.view==='team')ui.users=null;render();var m=document.getElementById('main');if(m)m.scrollTop=0;});

/* ---------- boot and background refresh ---------- */
function load(){return api('GET','/api/state').then(function(j){S=j.state;});}
function idle(){var a=document.activeElement;return !dlgHandler&&!ui.busy&&!(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));}
route();
load().then(render,function(e){document.getElementById('main').innerHTML='<div class="wrap"><div class="callout bad">Could not load the workspace: '+esc(e.message)+'</div></div>';});
setInterval(tick,1000);
setInterval(function(){if(S&&idle()&&!document.hidden)load().then(function(){if(idle())render();},function(){});},60000);
})();
