"""Constructed signals only: no Recorder input, timestamps, hardware IDs or replay data."""
from decimal import Decimal
from pathlib import Path
import json

def integral(points, start, end, price=False):
    total=Decimal(0)
    cuts=sorted({start,end,*[t for t,_ in points if start<t<end],*[t for t in (900,) if start<t<end]})
    for a,b in zip(cuts,cuts[1:]):
        watts=next(v for t,v in reversed(points) if t<=a)
        rate=Decimal('2') if a<900 else Decimal('-.5')
        total+=Decimal(watts)*Decimal(b-a)/Decimal(3600000)*(rate if price else 1)
    return total

def build():
    specs=[
        ('synthetic-wash','washing_machine',[[0,0],[120,80],[180,0],[210,70],[270,0],[300,1400],[720,90],[1200,0]],120,1200,1900),
        ('synthetic-dry','tumble_dryer',[[0,0],[120,280],[360,650],[1140,0],[1440,180],[1452,0],[1680,180],[1692,0],[1920,180],[1932,0]],120,1932,2700),
        ('synthetic-dish','dishwasher',[[0,0],[120,60],[240,1600],[600,0],[1500,1600],[1800,0],[1920,32],[1960,0],[2880,12],[2900,0],[2940,8],[2955,0]],120,1960,3300),
    ]
    runs=[]
    for name,profile,power,start,end,stop in specs:
        counter_times=sorted(set(range(0,stop+1,60))|{t for t,v in power}|{end,stop})
        energy=[[t,str(Decimal(10)+integral(power,0,t))] for t in counter_times]
        runs.append({'id':name,'profile':profile,'provenance':'Constructed step functions; no measured household data',
                     'power':power,'energy':energy,'prices':[
                         {'start':0,'end':900,'price':'2','provenance':'synthetic'},
                         {'start':900,'end':3600,'price':'-.5','provenance':'synthetic'}],
                     'stop':stop,'expected':{'start':start,'end':end,'kwh':str(integral(power,start,end)),
                         'cost':str(integral(power,start,end,True)),'main_end':1140 if profile=='tumble_dryer' else end}})
    return {'schema_version':1,'synthetic_only':True,'runs':runs}

if __name__=='__main__':
    Path(__file__).with_name('synthetic_profiles.json').write_text(json.dumps(build(),indent=2)+'\n')
