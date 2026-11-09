/** Synthetic hourly statistics only; no measured/private installation data. */
import { overviewDays } from '../../custom_components/appliance_meter/frontend/overview-data.js';
export function stressFixture(memberCount=7, now=Date.now(), zone='Europe/Copenhagen') {
  const days=overviewDays(now,zone),start=days[0].start,HOUR=3600000;
  const entries=[],hourly={},statisticsMetadata={},created={},states={};
  for(let i=0;i<memberCount;i++){
    const id='synthetic-'+i,sensors={power:`sensor.synthetic_${i}_power`,energy_total:`sensor.synthetic_${i}_energy`,cost_total:`sensor.synthetic_${i}_cost`,unpriced_energy:`sensor.synthetic_${i}_unpriced`};
    entries.push({entry_id:id,name:'Synthetic appliance '+i,type:'physical',state:'loaded',members:[],assignments:{},device_name:'Synthetic meter',sensors});created[id]=start-86400000;
    for(const key of ['energy_total','cost_total','unpriced_energy']){
      const sensor=sensors[key],cost=key==='cost_total',unpriced=key==='unpriced_energy',unit=cost?'DKK':'kWh',base=unpriced?0:cost?200+i:100+i,rate=unpriced?0:cost?.08:.04;
      const value=time=>base+(time-start)/HOUR*rate;
      hourly[sensor]=[];for(let end=start;end<=now;end+=HOUR)hourly[sensor].push({end,start:end-HOUR,state:value(end),sum:value(end)+1000,last_reset:null});
      statisticsMetadata[sensor]={statistic_id:sensor,has_sum:true,statistics_unit_of_measurement:unit};
      states[sensor]={state:String(value(now)),attributes:{unit_of_measurement:unit},last_updated:new Date(now).toISOString()};
    }
    states[sensors.power]={state:'40',attributes:{unit_of_measurement:'W'}};
  }
  const group={entry_id:'synthetic-total',name:'Synthetic Custom Total',type:'aggregate',state:'loaded',members:entries.map(e=>({entry_id:e.entry_id,name:e.name})),assignments:{},sensors:{power:'sensor.synthetic_total_power',energy_total:'sensor.synthetic_total_energy',cost_total:'sensor.synthetic_total_cost',unpriced_energy:'sensor.synthetic_total_unpriced'}};entries.push(group);
  return {metadata:{entries,entities:[],devices:[]},entry:group,states,data:{hourly,statisticsMetadata,created,warnings:[]},recordCount:Object.values(hourly).reduce((n,rows)=>n+rows.length,0),now,zone};
}
