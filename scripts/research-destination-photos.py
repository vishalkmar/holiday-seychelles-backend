"""Collect Wikimedia photo metadata; retain attribution and license for every photo.
Run with --download after reviewing photo-candidates.json. Never substitutes unrelated images.
"""
import concurrent.futures, html, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
DATA.mkdir(exist_ok=True)
QUERIES = {
 'mahe': 'Mahe Seychelles beach', 'praslin': 'Praslin beach', 'la-digue': 'La Digue beach',
 'curieuse': 'Curieuse island', 'sainte-anne-marine-park': 'Sainte Anne Seychelles',
 'anse-source-dargent': 'Anse Source Argent', 'morne-seychellois': 'Morne Seychellois',
 'beau-vallon': 'Beau Vallon Seychelles', 'anse-lazio': 'Anse Lazio',
 'anse-georgette': 'Anse Georgette', 'anse-intendance': 'Anse Intendance',
 'port-launay': 'Port Launay Seychelles', 'victoria': 'Victoria Seychelles',
 'vallee-de-mai': 'Vallee de Mai', 'aride': 'Aride Island', 'cousin': 'Cousin Island Seychelles',
 'bird-island': 'Bird Island Seychelles', 'silhouette': 'Silhouette island Seychelles',
 'moyenne': 'Moyenne Island', 'anse-severe': 'Anse Severe La Digue',
}
def request(url):
 for attempt in range(4):
  try:
   return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'HolidaySeychellesDestinationGuide/1.0 (Wikimedia licensed photography)'}),timeout=45)
  except Exception:
   if attempt == 3: raise
   time.sleep(15 + attempt * 10)
def clean(value): return html.unescape(re.sub('<[^>]+>', '', str(value or ''))).strip()
def collect(pair):
 slug, query = pair
 cached=DATA/(slug+'-photos.json')
 if cached.exists(): return slug,json.loads(cached.read_text(encoding='utf-8'))
 params = {'action':'query','generator':'search','gsrsearch':query+' filetype:bitmap','gsrnamespace':6,'gsrlimit':16,'prop':'imageinfo','iiprop':'url|extmetadata|size','iiurlwidth':1280,'format':'json'}
 result=json.load(request('https://commons.wikimedia.org/w/api.php?'+urllib.parse.urlencode(params)))
 photos=[]
 for page in sorted(result.get('query',{}).get('pages',{}).values(),key=lambda p:p.get('index',99)):
  info=page.get('imageinfo',[{}])[0]; meta=info.get('extmetadata',{})
  license=clean(meta.get('LicenseShortName',{}).get('value'))
  if not any(x in license.lower() for x in ['cc by','cc0','public domain']): continue
  if info.get('width',0)<600 or not re.search(r'\.(jpg|jpeg|png)$',page['title'],re.I): continue
  if re.search(r'\b(map|locator|coat of arms|flag|stamp|chart)\b',page['title'],re.I): continue
  photos.append({'title':page['title'],'url':info.get('thumburl',info.get('url','')).split('?')[0],
    'sourceUrl':info.get('descriptionurl',''),'credit':clean(meta.get('Artist',{}).get('value')),
    'license':license,'licenseUrl':meta.get('LicenseUrl',{}).get('value',''),
    'description':clean(meta.get('ImageDescription',{}).get('value'))[:1200], 'width':info.get('width'), 'height':info.get('height')})
 print(slug,len(photos),flush=True)
 cached.write_text(json.dumps(photos,ensure_ascii=False,indent=2),encoding='utf-8')
 time.sleep(2)
 return slug,photos

if '--download' not in sys.argv:
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  results=dict(executor.map(collect,QUERIES.items()))
 (DATA/'photo-candidates.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
else:
 chosen=json.loads((DATA/'photo-selection.json').read_text(encoding='utf-8'))
 dest=ROOT.parent.parent/'holidays-seychelles'/'public'/'images'/'destinations'
 dest.mkdir(parents=True,exist_ok=True)
 def download(pair):
  slug,photos=pair
  for i,photo in enumerate(photos):
   filename=f'{slug}-{i+1}.jpg'; target=dest/filename
   if not target.exists():
    # Wikimedia's supported thumbnail buckets avoid expensive arbitrary resizes.
    download_url=re.sub(r'/1280px-', '/960px-', photo['url'])
    if '/commons/thumb/' not in download_url:
     filename_url=download_url.rsplit('/',1)[-1]
     download_url=download_url.replace('/commons/', '/commons/thumb/')+'/960px-'+filename_url
    data=request(download_url).read()
    if len(data)<5000: raise RuntimeError('Invalid photo: '+filename)
    target.write_bytes(data)
   photo['originalUrl']=photo['url'];photo['url']='/images/destinations/'+filename
  print('Downloaded',slug,len(photos),flush=True)
  return slug,photos
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  results=dict(executor.map(download,chosen.items()))
 (DATA/'destination-photos.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
