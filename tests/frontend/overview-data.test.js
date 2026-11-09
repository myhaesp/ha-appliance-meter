import {test} from 'node:test';import assert from 'node:assert/strict';
import {overviewDays,overviewMembers,resolveOverviewMembers,overviewModel,loadOverviewData,prepareOverviewData,OVERVIEW_LIMITS} from '../../custom_components/appliance_meter/frontend/overview-data.js';
import {stressFixture} from './overview-stress-fixture.js';
const NOW=Date.parse('2026-11-04T12:30:00Z'),ZONE='Europe/Copenhagen',HOUR=3600000;
function fixture(n=1,now=NOW,zone=ZONE){const f=stressFixture(n,now,zone);if(n===1)f.entry=f.metadata.entries[0];f.days=overviewDays(now,zone);return f;}
const model=f=>overviewModel(f.metadata,f.entry,f.data,f.states,f.now,f.zone);
const id=(f,key)=>f.metadata.entries[0].sensors[key];
const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function api(f,calls=[]){return {connection:{},config:{time_zone:f.zone},callWS:async m=>{calls.push(m);assert(!m.type.startsWith('history/'));if(m.type==='recorder/statistics_during_period')return f.data.hourly;if(m.type==='recorder/list_statistic_ids')return Object.values(f.data.statisticsMetadata);if(m.type==='config_entries/get')return Object.entries(f.data.created).map(([entry_id,t])=>({entry_id,created_at:t/1000}));throw Error('Unexpected request');}};}

test('calendar dates include today and exact 23/25-hour DST intervals',()=>{
 assert.equal(overviewDays(NOW,ZONE).length,7);assert.equal(overviewDays(NOW,ZONE,30).length,30);
 for(const [date,hours] of [['2026-03-31T12:30Z',23],['2026-10-27T12:30Z',25]]){
  const f=fixture(1,Date.parse(date)),m=model(f);assert(f.days.some(d=>d.end-d.start===hours*HOUR));
  for(const d of m.days)near(d.energy.value,(d.end-d.start)/HOUR*.04);
  near(m.average.value,40);assert(m.days.at(-1).today);
 }
});
test('daily values use sum differences with predecessor, live tail counted once, historical price ignored',()=>{
 const f=fixture(),m=model(f);for(const d of m.days)near(d.energy.value,(d.end-d.start)/HOUR*.04);
 near(m.energy.value,(NOW-f.days[0].start)/HOUR*.04);near(m.cost.value,m.energy.value*2);near(m.average.value,40);
 assert.equal(m.days[0].energy.status,'complete');assert.equal(m.days.at(-1).energy.status,'partial');assert.equal(m.energy.status,'partial');
 f.states['sensor.price']={state:'99999'};near(model(f).cost.value,m.cost.value);
 // Different state/sum zero points are intentional; summing absolute sums is wrong.
 assert.notEqual(m.energy.value,f.data.hourly[id(f,'energy_total')].at(-1).sum);
});
test('exact-hour live endpoint does not double count the last compiled hour',()=>{
 const f=fixture(1,Date.parse('2026-11-04T12:00Z')),m=model(f);near(m.days.at(-1).energy.value,13*.04);
 f.states[id(f,'energy_total')].state=String(Number(f.states[id(f,'energy_total')].state)+.01);near(model(f).days.at(-1).energy.value,13*.04+.01);
});
test('zero statistics remain numeric zero; absent cost statistics remain unavailable',()=>{
 const f=fixture();for(const key of ['energy_total','cost_total']){const sensor=id(f,key);f.data.hourly[sensor].forEach(r=>{r.state=5;r.sum=0});f.states[sensor].state='5';}
 assert.equal(model(f).energy.value,0);assert.equal(model(f).cost.value,0);
 const g=fixture();delete g.data.hourly[id(g,'cost_total')];assert.equal(model(g).cost.value,null);assert(model(g).energy.value>0);
});
test('negative accumulated costs are preserved and disclosed as potentially ambiguous',()=>{
 const f=fixture(),sensor=id(f,'cost_total');f.data.hourly[sensor].forEach(r=>{r.state=500-r.state;r.sum=500-r.sum});f.states[sensor].state=String(500-Number(f.states[sensor].state));
 const m=model(f);assert(m.cost.value<0);assert.equal(m.cost.status,'partial');assert.match(m.days[0].cost.reason,/unmarked cost reset/);
});
test('unpriced consumption and missing unpriced statistics cannot certify zero cost',()=>{
 const f=fixture();f.states[id(f,'unpriced_energy')].state='0.5';const m=model(f);assert.equal(m.cost.status,'partial');assert.match(m.days.at(-1).cost.reason,/without a known price/);
 const g=fixture();delete g.data.hourly[id(g,'unpriced_energy')];assert.equal(model(g).days[0].cost.status,'partial');assert.match(model(g).days[0].cost.reason,/coverage is unknown/);
});
test('missing predecessor/end boundaries produce partial observed intervals, not invented full days',()=>{
 const f=fixture(),sensor=id(f,'energy_total');f.data.hourly[sensor].shift();const m=model(f);assert.equal(m.days[0].energy.status,'partial');near(m.days[0].energy.value,23*.04);assert.equal(m.days[0].energy.since,f.days[0].start+HOUR);
 const g=fixture();g.data.hourly[id(g,'energy_total')]=g.data.hourly[id(g,'energy_total')].filter(r=>r.end<g.days[1].start);const n=model(g);assert.equal(n.days[0].energy.status,'partial');assert.equal(n.days[2].energy.value,null);
});
test('internal gaps, null sums/states and unknown metadata fail closed',()=>{
 for(const kind of ['gap','sum','state','metadata']){const f=fixture(),sensor=id(f,'energy_total'),rows=f.data.hourly[sensor];if(kind==='gap')rows.splice(5,1);if(kind==='sum')rows[5].sum=null;if(kind==='state')rows[5].state=null;if(kind==='metadata')delete f.data.statisticsMetadata[sensor];assert.equal(model(f).days[0].energy.value,null,kind);}
});
test('reset markers, energy decreases and state/sum corrections are discontinuities',()=>{
 for(const kind of ['reset','decrease','correction','duplicate']){const f=fixture(),sensor=id(f,'energy_total'),rows=f.data.hourly[sensor];if(kind==='reset')rows[5].last_reset=rows[5].start;if(kind==='decrease'){rows[5].state=0;rows[5].sum=rows[4].sum-1;}if(kind==='correction')rows[5].sum+=100;if(kind==='duplicate')rows.splice(5,0,{...rows[5]});assert.equal(model(f).days[0].energy.status,'discontinuity',kind);}
 const f=fixture();f.data.hourly[id(f,'cost_total')][5].last_reset=f.days[0].start+HOUR;assert.equal(model(f).days[0].cost.value,null);
});
test('live unavailable/restored/wrong units retain only recorded cutoff, without stretching average duration',()=>{
 for(const kind of ['unavailable','restored','unit']){const f=fixture(),sensor=id(f,'energy_total');if(kind==='unavailable')f.states[sensor].state='unavailable';if(kind==='restored')f.states[sensor].attributes.restored=true;if(kind==='unit')f.states[sensor].attributes.unit_of_measurement='Wh';const d=model(f).days.at(-1);assert.equal(d.energy.status,'partial');assert.equal(d.energy.end,f.data.hourly[sensor].at(-1).end);assert.match(d.energy.reason,/recorded cutoff/);near(model(f).average.value,40);}
});
test('current live decreases and explicit resets remain flagged through later updates',()=>{
 const f=fixture(),sensor=id(f,'energy_total');model(f);f.states[sensor].state=String(Number(f.states[sensor].state)+1);model(f);f.states[sensor].state=String(Number(f.states[sensor].state)-.1);assert.equal(model(f).days.at(-1).energy.status,'discontinuity');f.states[sensor].state='999';assert.equal(model(f).days.at(-1).energy.value,null);
 const g=fixture();g.states[id(g,'cost_total')].attributes.last_reset=new Date(NOW-1000).toISOString();assert.equal(model(g).days.at(-1).cost.status,'discontinuity');
});
test('stale statistics stop at the actual cutoff rather than inferring an unbounded live tail',()=>{
 const f=fixture();for(const sensor of Object.values(f.entry.sensors))if(f.data.hourly[sensor])f.data.hourly[sensor]=f.data.hourly[sensor].filter(r=>r.end<=NOW-3*HOUR);
 const d=model(f).days.at(-1);assert(d.energy.end<NOW-2*HOUR);assert.equal(d.energy.status,'partial');assert.match(d.energy.reason,/stale/);
});
test('creation time prevents reused-entity statistics from claiming earlier days',()=>{
 const f=fixture();f.data.created[f.entry.entry_id]=f.days[3].start+HOUR;assert.equal(model(f).days[0].energy.value,null);assert.equal(model(f).days[3].energy.status,'partial');
 const g=fixture();delete g.data.created[g.entry.entry_id];assert.equal(model(g).energy.value,null);
});
test('seven Physical members sum once; nested shared leaves and duplicate direct references are deduplicated',()=>{
 const f=fixture(7),expected=model(f).energy.value,leaves=f.metadata.entries.filter(e=>e.type==='physical');
 const subgroup={entry_id:'sub',type:'aggregate',members:leaves.slice(0,4).map(e=>({entry_id:e.entry_id}))};f.metadata.entries.push(subgroup);f.entry.members.push({entry_id:'sub'},{entry_id:leaves[0].entry_id});assert.equal(overviewMembers(f.metadata,f.entry).length,7);near(model(f).energy.value,expected);
 const g=fixture(2);const cost=id(g,'cost_total');g.data.statisticsMetadata[cost].statistics_unit_of_measurement='EUR';assert.equal(model(g).cost.value,null);
});
test('cycles, missing/empty groups and member/graph limits cause no statistics requests',async()=>{
 for(const kind of ['cycle','missing','empty','limit']){const f=fixture(kind==='limit'?65:7);if(kind==='cycle')f.entry.members.push({entry_id:f.entry.entry_id});if(kind==='missing')f.entry.members.push({entry_id:'missing'});if(kind==='empty')f.entry.members=[];const calls=[];const d=await loadOverviewData(api(f,calls),f.metadata,f.entry,NOW);assert.equal(calls.length,0,kind);assert(d.warnings.length);assert.equal(overviewModel(f.metadata,f.entry,d,f.states,NOW,ZONE).energy.value,null);}
 const f=fixture();const a={entry_id:'a',type:'aggregate',members:[{entry_id:'b'}]},b={entry_id:'b',type:'aggregate',members:[{entry_id:'a'}]};f.metadata.entries.push(a,b);assert.match(resolveOverviewMembers(f.metadata,a).error,/cycle/);
});
test('loader makes exactly one batched hourly request plus metadata; no raw history, and bounds precede API calls',async()=>{
 const f=fixture(7),calls=[],hass=api(f,calls),d=await loadOverviewData(hass,f.metadata,f.entry,NOW);
 assert.equal(calls.length,3);const q=calls.find(c=>c.type==='recorder/statistics_during_period');assert.equal(q.statistic_ids.length,21);assert.equal(q.period,'hour');assert.deepEqual(q.types,['state','sum','last_reset']);assert.equal(Date.parse(q.start_time),f.days[0].start-HOUR);assert.equal(d.history,undefined);assert.equal(d.warnings.length,0);
 const before=calls.length;const unsupported=await loadOverviewData(hass,f.metadata,f.entry,NOW,30);assert(unsupported.warnings.length);assert.equal(calls.length,before);
});
test('oversized statistics are rejected, API failures retry and never fall back to history',async()=>{
 const f=fixture(),calls=[],hass=api(f,calls);f.data.hourly[id(f,'energy_total')]=Array.from({length:OVERVIEW_LIMITS.rowsPerSeries+1},()=>({}));const d=await loadOverviewData(hass,f.metadata,f.entry,NOW);assert.match(d.warnings[0],/safe response limit/);assert.deepEqual(d.hourly,{});
 const g=fixture(),requests=[],broken=api(g,requests);broken.callWS=async m=>{requests.push(m);throw Error('offline')};const failed=await loadOverviewData(broken,g.metadata,g.entry,NOW);assert.equal(failed.warnings.length,3);broken.callWS=api(g,requests).callWS;await loadOverviewData(broken,g.metadata,g.entry,NOW+1);assert.equal(requests.length,6);assert(requests.every(m=>!m.type.startsWith('history/')));
});
test('cache deduplicates A-B-A, shares metadata, expires and refreshes explicitly',async()=>{
 const f=fixture(2),calls=[],hass=api(f,calls),a=f.metadata.entries[0],b=f.metadata.entries[1];
 await Promise.all([loadOverviewData(hass,f.metadata,a,NOW),loadOverviewData(hass,f.metadata,a,NOW)]);assert.equal(calls.length,3);
 await loadOverviewData(hass,f.metadata,b,NOW);assert.equal(calls.length,4);await loadOverviewData(hass,f.metadata,a,NOW+1);assert.equal(calls.length,4);
 await loadOverviewData(hass,f.metadata,a,NOW+2,7,true);assert.equal(calls.length,7);await loadOverviewData(hass,f.metadata,a,NOW+62000);assert.equal(calls.length,10);
});
test('ten pending selections and a repeated first selection deduplicate beyond cache capacity with concurrency two',async()=>{
 const f=fixture(10),calls=[],hass=api(f,calls),base=hass.callWS;let release,active=0,max=0;const gate=new Promise(r=>release=r);hass.callWS=async m=>{if(m.type==='recorder/statistics_during_period'){active++;max=Math.max(max,active);await gate;try{return await base(m)}finally{active--;}}return base(m)};
 const entries=f.metadata.entries.filter(e=>e.type==='physical'),pending=entries.map(e=>loadOverviewData(hass,f.metadata,e,NOW));pending.push(loadOverviewData(hass,f.metadata,entries[0],NOW+1));await new Promise(r=>setTimeout(r,0));assert.equal(active,2);release();await Promise.all(pending);assert.equal(max,2);assert.equal(calls.filter(c=>c.type==='recorder/statistics_during_period').length,10);
});
test('warm statistics cache matches fresh results across live increments',()=>{
 const f=fixture(7);model(f);for(let i=0;i<20;i++){for(const m of f.metadata.entries.filter(e=>e.type==='physical'))f.states[m.sensors.energy_total].state=String(Number(f.states[m.sensors.energy_total].state)+.001);assert.deepEqual(model(f),overviewModel(f.metadata,f.entry,structuredClone(f.data),f.states,NOW,ZONE));}
});
test('cooperative preparation yields and cancellation does not scan records',async()=>{
 const f=fixture(7);let yielded=false,time=0;const original=performance.now;try{performance.now=()=>time+=9;setTimeout(()=>yielded=true,0);assert(await prepareOverviewData(f.metadata,f.entry,f.data,f.states,NOW,ZONE));assert(yielded);}finally{performance.now=original;}
 const denied=new Proxy({}, {get(){throw Error('No access')}});assert.equal(await prepareOverviewData(f.metadata,f.entry,denied,f.states,NOW,ZONE,()=>false),false);
});

test('delayed compilation uses only the last statistical state-to-live tail once',()=>{
 const f=fixture();for(const sensor of Object.values(f.entry.sensors))if(f.data.hourly[sensor])f.data.hourly[sensor].pop();
 const m=model(f);near(m.days.at(-1).energy.value,(NOW-f.days.at(-1).start)/HOUR*.04);near(m.average.value,40);assert.match(m.days.at(-1).energy.reason,/latest compiled hourly state/);
});
test('wrong units, missing has_sum and absent creation never become complete zero cost',()=>{
 for(const kind of ['unit','sum','creation']){const f=fixture(),sensor=id(f,'cost_total');if(kind==='unit')f.data.statisticsMetadata[sensor].statistics_unit_of_measurement=null;if(kind==='sum')f.data.statisticsMetadata[sensor].has_sum=false;if(kind==='creation')delete f.data.created[f.entry.entry_id];assert.equal(model(f).days[0].cost.value,null,kind);}
});
test('an unavailable live cost counter retains only a disclosed partial recorded subtotal',()=>{
 const f=fixture(),sensor=id(f,'cost_total');f.states[sensor].state='unavailable';const m=model(f);assert.equal(m.days.at(-1).cost.status,'partial');assert.match(m.days.at(-1).cost.reason,/recorded cutoff/);assert(m.days.at(-1).cost.end<NOW);
});
test('graph node and edge limits reject pathological acyclic expansion before requests',async()=>{
 const f=fixture(),leaf=f.entry;const chain=Array.from({length:513},(_,i)=>({entry_id:'chain-'+i,type:'aggregate',members:[{entry_id:i===512?leaf.entry_id:'chain-'+(i+1)}]}));f.metadata.entries.push(...chain);assert.match(resolveOverviewMembers(f.metadata,chain[0]).error,/graph limit/);
 const many={entry_id:'edges',type:'aggregate',members:Array.from({length:2049},()=>({entry_id:leaf.entry_id}))};f.metadata.entries.push(many);const calls=[];const d=await loadOverviewData(api(f,calls),f.metadata,many,NOW);assert.equal(calls.length,0);assert.match(d.warnings[0],/graph limit/);
});

test('malformed statistics rows and reset timestamps fail closed without throwing',()=>{
 for(const kind of ['null','reset','duration']){const f=fixture(),rows=f.data.hourly[id(f,'energy_total')];if(kind==='null')rows[5]=null;if(kind==='reset')rows[5].last_reset='not-a-timestamp';if(kind==='duration')rows[5].start-=1000;assert.equal(model(f).days[0].energy.status,'discontinuity',kind);}
});
