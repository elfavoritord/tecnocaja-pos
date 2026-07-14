/* ====== CONFIGURACIÓN DE LA DESCARGA ======
   Pon aquí la URL o ruta de tu instalador real del POS.
   Ejemplo si subes el .exe junto a esta página:
   const URL_INSTALADOR = "descargas/TecnoCaja-Setup.exe";
   Mientras esté vacío, el botón descarga un archivo de instrucciones
   para que ya funcione. */
const URL_INSTALADOR = "descargas/TecnoCaja-Setup-1.1.18.exe";

function descargarDemo(){
  if (URL_INSTALADOR && URL_INSTALADOR.trim() !== "") {
    const a = document.createElement('a');
    a.href = URL_INSTALADOR;
    a.setAttribute('download','');
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    const texto =
"========================================\n" +
"   TECNO CAJA - DEMO 30 DIAS GRATIS\n" +
"   Sistema POS para Republica Dominicana\n" +
"========================================\n\n" +
"Gracias por tu interes en Tecno Caja!\n\n" +
"Para recibir el instalador del sistema (Windows) y activar\n" +
"tu demo de 30 dias gratis, contactanos:\n\n" +
"  WhatsApp: 829 281 2877\n" +
"  Correo:   emiliomanaurys@gmail.com\n\n" +
"Te enviamos el instalador y te ayudamos con la configuracion\n" +
"inicial: productos, impresora termica y facturacion fiscal DGII.\n\n" +
"----------------------------------------\n" +
"NOTA PARA EL ADMINISTRADOR DEL SITIO:\n" +
"Para que este boton descargue el .exe real, edita la linea\n" +
"  const URL_INSTALADOR = \"\";\n" +
"y coloca la ruta de tu instalador, por ejemplo:\n" +
"  const URL_INSTALADOR = \"descargas/TecnoCaja-Setup.exe\";\n" +
"----------------------------------------\n";
    const blob = new Blob([texto], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Tecno-Caja-Demo-30-dias.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  // confirmación visual
  const t = document.getElementById('toast');
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),4200);
}

/* nav scroll */
const header = document.getElementById('header');
window.addEventListener('scroll',()=>{
  header.classList.toggle('scrolled', window.scrollY > 24);
});

/* menú móvil */
const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks');
burger.addEventListener('click',()=> navLinks.classList.toggle('mobile'));
navLinks.querySelectorAll('a').forEach(a=> a.addEventListener('click',()=> navLinks.classList.remove('mobile')));

/* reveal on scroll */
const io = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target);} });
},{threshold:.12, rootMargin:'0px 0px -40px 0px'});
document.querySelectorAll('.reveal').forEach(el=> io.observe(el));

/* FAQ acordeón */
document.querySelectorAll('.faq-item').forEach(item=>{
  const q = item.querySelector('.faq-q');
  const a = item.querySelector('.faq-a');
  const toggle = ()=>{
    const open = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i=>{
      i.classList.remove('open');
      i.querySelector('.faq-a').style.maxHeight=null;
      i.querySelector('.faq-q').setAttribute('aria-expanded','false');
    });
    if(!open){
      item.classList.add('open');
      a.style.maxHeight = a.scrollHeight + 'px';
      q.setAttribute('aria-expanded','true');
    }
  };
  q.addEventListener('click', toggle);
  q.addEventListener('keydown', (ev)=>{
    if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); toggle(); }
  });
});

/* service worker (offline + caché de estáticos) */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

/* parallax suave del cluster de dispositivos */
const devices = document.querySelector('.devices');
if(devices && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && window.matchMedia('(min-width: 981px)').matches){
  const layers = [
    {el: document.querySelector('.pos-window'), f: 14},
    {el: document.querySelector('.phone'), f: 26},
    {el: document.querySelector('.map-card'), f: 34}
  ];
  document.querySelector('.hero').addEventListener('mousemove',(ev)=>{
    const r = devices.getBoundingClientRect();
    const cx = (ev.clientX - (r.left + r.width/2)) / r.width;
    const cy = (ev.clientY - (r.top + r.height/2)) / r.height;
    layers.forEach(l=>{ if(l.el) l.el.style.setProperty('translate', (cx*l.f)+'px '+(cy*l.f)+'px'); });
  });
}

/* contador animado del total del hero */
(function(){
  const el = document.getElementById('heroTotal');
  if(!el) return;
  let val = 405, dir = 1;
  setInterval(()=>{
    if(Math.random()>.6){
      const inc = Math.floor(Math.random()*120)+25;
      val += inc;
      if(val>1200) val = 405;
      el.textContent = 'RD$ ' + val.toLocaleString('es-DO');
      el.style.transition='transform .2s'; el.style.transform='scale(1.08)';
      setTimeout(()=> el.style.transform='scale(1)',200);
    }
  },2600);
})();
