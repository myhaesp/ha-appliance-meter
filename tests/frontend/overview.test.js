import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const window = new Window();globalThis.document=window.document;
const { dailyChart, overviewContent, overviewDebugContent, OverviewView }=await import('../../custom_components/appliance_meter/frontend/overview.js');
const good=(value,status='complete')=>({value,status,reason:'Recorded counter difference.',since:1});
const missing={value:null,status:'unavailable',reason:'No baseline.',since:null};
const days=[{start:Date.parse('2026-11-03T23:00Z'),today:true,energy:good(1,'partial'),cost:good(-2)}];
const tick=()=>new Promise(r=>setTimeout(r,0));

test('charts use theme SVG, support negative costs, distinguish missing from zero, and expose daily accessible data',()=>{
 const chart=dailyChart([...days,{...days[0],cost:missing},{...days[0],cost:good(0)}],'cost','DKK','Europe/Copenhagen');
 assert(chart.querySelector('svg[role="img"]'));assert.equal(chart.querySelectorAll('rect').length,2);
 assert.equal(chart.querySelectorAll('tbody tr').length,3);
 assert.match(chart.textContent,/-2,00 DKK/);assert.match(chart.textContent,/Unavailable/);assert.match(chart.textContent,/0,00 DKK/);
 assert(chart.querySelector('.chart-partial'));assert.match(chart.textContent,/Today so far/);assert.match(chart.querySelector('svg').textContent,/Today\*/);
 for(const bar of chart.querySelectorAll('rect'))assert(Number(bar.getAttribute('height'))>0);
});

test('Overview contains only summaries, charts and one footnote; technical details and warnings live in Debug',()=>{
 const model={days,energy:good(1,'partial'),cost:good(-2),average:good(45),currency:'EUR',aggregate:true,warnings:['Statistics unavailable.']};
 const content=overviewContent(model,'UTC'),debug=overviewDebugContent(model,'UTC');
 assert.deepEqual([...content.querySelectorAll('.overview-totals dt')].map(e=>e.textContent),['Total Energy','Total Cost','Average Power']);
 assert.equal(content.querySelectorAll('figure').length,2);assert.equal(content.querySelectorAll('p').length,1);
 assert.equal(content.querySelectorAll('button').length,0);assert.match(content.textContent,/45,00 W \*/);
 assert.match(content.textContent,/\(\*\) Partial coverage. See Debug/);assert.doesNotMatch(content.textContent,/cumulative|membership|hourly|baseline|repricing|cutoff/i);
 assert.match(debug.textContent,/Past group membership is not reconstructed/);assert.match(debug.textContent,/never today's price/);
 assert.match(debug.textContent,/cumulative sums/);assert.match(debug.textContent,/23\/25-hour/);assert.match(debug.textContent,/uninterrupted source availability/);
 assert.match(debug.textContent,/Unpriced consumption/);assert.match(debug.textContent,/Negative electricity prices/);
 assert.equal(debug.querySelector('[role=alert]').textContent,'Statistics unavailable.');assert(!debug.querySelector('[role=alert]').closest('details'));
 assert([...content.querySelectorAll('.overview-totals dd')].every(e=>e.textContent.endsWith('*')));
 assert.equal(content.querySelectorAll('svg rect:not(.chart-partial)').length,0);
});

test('closed or superseded overview reads never repaint, and retry is available after errors',async()=>{
 const entry={entry_id:'one',type:'physical',sensors:{energy_total:'sensor.energy'}};
 const metadata={entries:[entry]},connection={};let resolvers=[];
 const hass={user:{is_admin:true},config:{time_zone:'UTC'},states:{},connection,callWS:()=>new Promise(r=>resolvers.push(r))};
 const view=new OverviewView();view.update(hass,metadata,entry);await tick();assert.equal(resolvers.length,3);
 view.close();resolvers.forEach(r=>r({}));await tick();assert.equal(view.element.querySelectorAll('svg').length,0);
 const retry=new OverviewView();hass.callWS=async()=>{throw Error('offline')};retry.update(hass,metadata,entry);for(let i=0;i<100&&!retry.data;i++)await tick();
 assert.match(retry.element.textContent,/Unavailable/);assert.equal(retry.refreshButton.disabled,false);
 hass.callWS=async()=>({});await retry.refresh();assert.equal(retry.element.querySelectorAll('svg').length,2);
 const count=retry.element.querySelectorAll('svg').length;retry.update({...hass,user:{is_admin:false}},metadata,entry);assert.equal(retry.element.querySelectorAll('svg').length,count);
 retry.close();
});

test('stable hass updates reuse history and refresh only explicitly or on context changes',async()=>{
 let calls=0;const entry={entry_id:'one',type:'physical',sensors:{energy_total:'sensor.energy'}};
 const hass={user:{is_admin:true},config:{time_zone:'UTC'},states:{},connection:{},callWS:async()=>{calls++;return {}}};
 const view=new OverviewView(), metadata={entries:[entry]};view.update(hass,metadata,entry);await tick();
 assert.equal(calls,3);view.update(hass,metadata,entry);await tick();assert.equal(calls,3);
 await view.refresh();assert.equal(calls,6);view.update({...hass,connection:{}},metadata,entry);await tick();assert.equal(calls,9);view.close();
});

test('unrelated hass bursts do not aggregate/rebuild charts; hidden tabs defer only relevant updates',async()=>{
 const {stressFixture}=await import('./overview-stress-fixture.js');
 const fixed=Date.now(),originalNow=Date.now;Date.now=()=>fixed;
 try{
  const f=stressFixture(7,fixed);let requests=0;
  const hass={connection:{},user:{is_admin:true},config:{time_zone:f.zone},states:f.states,callWS:async m=>{
   requests++;
   if(m.type==='recorder/statistics_during_period')return f.data.hourly;
   if(m.type==='recorder/list_statistic_ids')return Object.values(f.data.statisticsMetadata);
   return Object.entries(f.data.created).map(([entry_id,t])=>({entry_id,created_at:t/1000}));
  }};
  const view=new OverviewView(),host=document.createElement('section');host.append(view.element);document.body.append(host);
  view.update(hass,f.metadata,f.entry);for(let i=0;i<100&&!view.data;i++)await tick();assert(view.data);let replacements=0;
  const replace=view.body.replaceChildren.bind(view.body);view.body.replaceChildren=(...children)=>{replacements++;return replace(...children)};
  for(let i=0;i<100;i++)view.update({...hass,states:{...hass.states,'sensor.unrelated':{state:String(i)}}},f.metadata,f.entry);
  assert.equal(replacements,0);assert.equal(requests,3);
  const id=f.metadata.entries[0].sensors.energy_total;
  hass.states={...hass.states,[id]:{...hass.states[id],state:String(Number(hass.states[id].state)+.1)}};
  view.update(hass,f.metadata,f.entry);assert.equal(replacements,1);assert.equal(requests,3);
  host.hidden=true;hass.states={...hass.states,[id]:{...hass.states[id],state:String(Number(hass.states[id].state)+.1)}};
  view.update(hass,f.metadata,f.entry);assert.equal(replacements,1);
  host.hidden=false;view.render();assert.equal(replacements,2);view.render();assert.equal(replacements,2);
  view.close();host.remove();
 }finally{Date.now=originalNow;}
});

test('manual refresh releases the old rendered snapshot while the replacement is loading',async()=>{
 const entry={entry_id:'one',type:'physical',sensors:{energy_total:'sensor.energy'}},metadata={entries:[entry]};
 const hass={connection:{},user:{is_admin:true},states:{},config:{time_zone:'UTC'},callWS:async()=>({})};
 const view=new OverviewView();view.update(hass,metadata,entry);await tick();assert(view.renderedData);
 let release;const gate=new Promise(r=>release=r);hass.callWS=()=>gate;
 const pending=view.refresh();await tick();assert.equal(view.data,null);assert.equal(view.renderedData,null);
 release({});await pending;assert(view.renderedData);view.close();
});

test('today recorded cutoffs are presented in HA local time rather than UTC',()=>{
 const end=Date.parse('2026-11-04T12:30:00Z');
 const content=overviewDebugContent({days:[{...days[0],energy:{...good(1,'partial'),end},cost:{...good(2,'partial'),end:end-1800000}}],energy:good(1,'partial'),cost:good(2,'partial'),average:good(40),currency:'DKK',warnings:[]},'Europe/Copenhagen');
 assert.match(content.textContent,/13[.:]30/);assert.match(content.textContent,/13[.:]00/);assert.match(content.textContent,/Europe\/Copenhagen/);assert.doesNotMatch(content.textContent,/T12:30/);
});


test('historical partial dates and unavailable summaries keep markers, while genuine zero stays zero',()=>{
 const historical={...days[0],today:false,energy:good(0,'partial'),cost:missing};
 const chart=dailyChart([historical],'energy','kWh','UTC');assert.match(chart.textContent,/0,00 kWh \*/);assert.match(chart.querySelector('svg').textContent,/03.11\*/);
 assert.equal(chart.querySelectorAll('rect.chart-partial').length,1);
 const content=overviewContent({days:[historical],energy:good(0),cost:missing,average:missing,currency:'DKK',warnings:[]},'UTC');
 assert.equal(content.querySelectorAll('.overview-totals dd')[0].textContent,'0,00 kWh');
 assert.equal(content.querySelectorAll('.overview-totals dd')[1].textContent,'Unavailable *');
 assert.equal(content.querySelectorAll('p').length,1);
});

test('Debug details update lazily, preserve expansion and Refresh statistics works while Overview is hidden',async()=>{
 const {stressFixture}=await import('./overview-stress-fixture.js'),f=stressFixture(7),calls=[];
 const hass={connection:{},user:{is_admin:true},config:{time_zone:f.zone},states:f.states,callWS:async m=>{
  calls.push(m);if(m.type==='recorder/statistics_during_period')return f.data.hourly;
  if(m.type==='recorder/list_statistic_ids')return Object.values(f.data.statisticsMetadata);
  return Object.entries(f.data.created).map(([entry_id,t])=>({entry_id,created_at:t/1000}));
 }};
 const view=new OverviewView(),overview=document.createElement('section'),debug=document.createElement('section');overview.append(view.element);debug.append(view.debugElement);debug.hidden=true;document.body.append(overview,debug);
 view.update(hass,f.metadata,f.entry);for(let i=0;i<100&&!view.data;i++)await tick();assert(view.data);
 assert.equal(view.element.querySelector('button'),null);assert.equal(view.debugElement.querySelector('button'),view.refreshButton);
 assert.equal(view.debugBody.querySelector('details'),null);const charts=view.body.firstChild;
 overview.hidden=true;debug.hidden=false;view.render();assert(view.debugBody.querySelector('details'));view.debugBody.querySelector('details').open=true;
 let edits=0;const replace=view.debugBody.replaceChildren.bind(view.debugBody);view.debugBody.replaceChildren=(...args)=>{edits++;return replace(...args)};
 const sensor=f.metadata.entries[0].sensors.energy_total;
 const next={...hass,states:{...hass.states,[sensor]:{...hass.states[sensor],state:String(Number(hass.states[sensor].state)+.01)}}};
 view.update(next,f.metadata,f.entry);assert.equal(edits,1);assert(view.debugBody.querySelector('details').open);assert.equal(view.body.firstChild,charts);
 view.update({...next,states:{...next.states,'sensor.unrelated':{state:'2'}}},f.metadata,f.entry);assert.equal(edits,1);assert.equal(calls.length,3);
 await view.refresh();assert.equal(calls.length,6);assert.equal(view.refreshButton.disabled,false);assert(view.debugBody.querySelector('details'));assert.equal(view.body.querySelectorAll('svg').length,0);
 overview.hidden=false;debug.hidden=true;view.render();assert.equal(view.body.querySelectorAll('svg').length,2);
 view.close();overview.remove();debug.remove();
});
