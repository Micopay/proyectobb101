import json, sys, time, websocket

AUDIT = r"""
(() => {
  // Tailwind v4 emite oklch() para su paleta por defecto. Leerlo como si
  // fuera rgb() da ratios inventados: hay que convertirlo de verdad.
  const aRGB = c => {
    if(!c) return null;
    if(c.startsWith('rgb')) { const m=c.match(/[\d.]+/g); return m?m.slice(0,3).map(Number):null; }
    const el=document.createElement('div');
    el.style.color=c; document.body.appendChild(el);
    const r=getComputedStyle(el).color; el.remove();
    const m=r.match(/[\d.]+/g); return m&&r.startsWith('rgb')?m.slice(0,3).map(Number):null;
  };
  const lum = c => { const m=aRGB(c); if(!m) return null;
    const [r,g,b]=m.map(v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)});
    return 0.2126*r+0.7152*g+0.0722*b; };
  const ratio=(a,b)=>{const L1=lum(a),L2=lum(b); if(L1==null||L2==null) return null;
    return +(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)).toFixed(2));};
  // Compone la pila de fondos respetando el alfa. Sin esto, un fondo del
  // mismo color al 10% se lee como opaco y sale un 1:1 que no existe.
  const parse = c => { const rgb=aRGB(c); if(!rgb) return null;
    const m=(c||'').match(/[\d.]+/g); const a=(c||'').includes('/')||m&&m.length>3?Number((m||[]).slice(-1)[0]):1;
    return [...rgb, isNaN(a)?1:(a>1?1:a)]; };
  const sobre = (f, atras) => f[3]>=1 ? f :
    [0,1,2].map(i=>f[i]*f[3]+atras[i]*(1-f[3])).concat(1);
  const fondoDe = el => {
    const capas=[]; let p=el;
    while(p){ const c=parse(getComputedStyle(p).backgroundColor);
      if(c && c[3]>0) capas.push(c); if(c && c[3]>=1) break; p=p.parentElement; }
    let base=[245,241,232,1];
    for(let i=capas.length-1;i>=0;i--) base=sobre(capas[i],base);
    return `rgb(${Math.round(base[0])}, ${Math.round(base[1])}, ${Math.round(base[2])})`; };

  const bajos=[], iconosRotos=[], tactilesChicos=[];
  document.querySelectorAll('*').forEach(el=>{
    const r=el.getBoundingClientRect();
    if(r.width===0||r.height===0) return;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.opacity==='0') return;

    // icono dibujado como palabra
    if(el.classList.contains('material-symbols-outlined')){
      // Medir la CAJA no sirve: un boton-icono de 48 dp es ancho aunque el
      // glifo este bien. Se mide el nodo de texto con un Range, que da el
      // ancho real de lo dibujado.
      const tn=[...el.childNodes].find(n=>n.nodeType===3);
      if(tn){ const rg=document.createRange(); rg.selectNodeContents(tn);
        const w=rg.getBoundingClientRect().width;
        if(w > parseFloat(cs.fontSize)*1.8) iconosRotos.push(el.textContent.trim().slice(0,30)); }
    }

    // texto directo
    const propio=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
    if(propio.length>1 && !el.classList.contains('material-symbols-outlined')){
      const px=parseFloat(cs.fontSize), peso=parseInt(cs.fontWeight)||400;
      const grande = px>=24 || (px>=18.66 && peso>=700);
      const c=ratio(cs.color, fondoDe(el));
      if(c!==null && c < (grande?3:4.5))
        bajos.push({t:propio.slice(0,26), c, px:Math.round(px), cls:(el.className||'').toString().slice(0,70), col:cs.color, bg:fondoDe(el)});
    }

    // área táctil
    if((el.tagName==='BUTTON'||el.tagName==='A') && (r.height<44||r.width<44))
      tactilesChicos.push({tag:el.tagName, t:(el.textContent||'').trim().slice(0,18),
                           h:Math.round(r.height), w:Math.round(r.width), cls:(el.className||'').toString().slice(0,60)});
  });
  const dedup=(a,k)=>{const s=new Set(),o=[];for(const x of a){const j=k(x);if(!s.has(j)){s.add(j);o.push(x);}}return o;};
  return {
    desbordeH: document.documentElement.scrollWidth > window.innerWidth + 2,
    anchoDoc: document.documentElement.scrollWidth, anchoVent: window.innerWidth,
    contrasteBajo: dedup(bajos,x=>x.t+x.c).slice(0,8),
    iconosRotos: [...new Set(iconosRotos)],
    tactilesChicos: dedup(tactilesChicos,x=>x.t+x.h).slice(0,5)
  };
})()
"""

ws_url, rutas = sys.argv[1], ["#/"+r for r in sys.argv[2].split(",")]
ws = websocket.create_connection(ws_url, timeout=25, suppress_origin=True, host="localhost:9222")
mid = 0
def ev(expr, espera=0.0):
    global mid; mid += 1
    ws.send(json.dumps({"id":mid,"method":"Runtime.evaluate",
                        "params":{"expression":expr,"returnByValue":True,"awaitPromise":True}}))
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==mid:
            if espera: time.sleep(espera)
            return m.get("result",{}).get("result",{}).get("value")

for ruta in rutas:
    ev(f"window.location.hash = '{ruta}'", 2.2)
    try:
        r = ev(AUDIT)
    except Exception as e:
        print(f"\n### {ruta}  -> ERROR {e}"); continue
    if not isinstance(r, dict):
        print(f"\n### {ruta}  -> sin datos"); continue
    problemas = (r['desbordeH'] or r['contrasteBajo'] or r['iconosRotos'] or r['tactilesChicos'])
    print(f"\n### {ruta}  {'PROBLEMAS' if problemas else 'ok'}")
    if r['desbordeH']: print(f"  desborde horizontal: {r['anchoDoc']}px en ventana de {r['anchoVent']}px")
    for x in r['iconosRotos']: print(f"  icono como palabra: {x}")
    for x in r['contrasteBajo']:
        print(f"  contraste {x['c']}:1 {x['px']}px \"{x['t']}\"")
        print(f"      {x['col']} sobre {x['bg']}")
        print(f"      clases: {x['cls']}")
    for x in r['tactilesChicos']:
        print(f"  tactil {x['w']}x{x['h']}dp \"{x['t']}\"")
        print(f"      clases: {x.get('cls','')}")
ws.close()
