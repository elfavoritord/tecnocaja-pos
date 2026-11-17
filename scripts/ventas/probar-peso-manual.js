// Prueba real aislada: categorías y venta por peso sin báscula.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TC_E2E_DIR = path.join(os.tmpdir(), 'tecnocaja-peso-manual');
const L = require('../e2e-lan/lib');
const puppeteer = require('puppeteer');
(async () => {
  let server, browser;
  const check = (name, ok, detail) => { L.check(name, ok, detail); if (!ok) throw new Error(name); };
  try {
    L.prepareSandbox();
    const userData = path.join(L.WORK, `pc-${Date.now()}`);
    const home = path.join(L.WORK, 'home');
    const out = path.join(L.WORK, 'capturas');
    fs.mkdirSync(path.join(home, 'Documents'), {recursive:true});fs.mkdirSync(out, {recursive:true});
    server = L.startServer('peso-manual', {port:3492,userData,env:{DB_CLIENT:'sqlite',USERPROFILE:home,HOME:home,TECNO_CAJA_DEMO:'1',TECNO_CAJA_SYNC_URL:'off'}});
    await L.waitHttp(3492);
    await L.request(3492,'POST','/api/setup/complete',{language:'es',businessType:'colmado',businessStructureMode:'monocaja',businessName:'Prueba peso manual',adminName:'Admin',adminUser:'admin',adminEmail:'admin@prueba.test',adminPassword:'1234',openingAmount:1000,currency:'RD$'});
    browser = await puppeteer.launch({headless:true});
    const page=await browser.newPage();await page.setViewport({width:1209,height:694});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto('http://127.0.0.1:3492/',{waitUntil:'networkidle2'});
    await page.waitForSelector('#login-user');
    await page.evaluate(async()=>{document.getElementById('login-user').value='admin';document.getElementById('login-pass').value='1234';await doLogin();});
    await page.waitForFunction(()=>typeof DB!=='undefined' && DB.currentUser);
    await page.evaluate(()=>{showModule('productos');openProductModal();toggleNewCategoryForm(true);});
    const bounds=await page.evaluate(()=>{const box=document.getElementById('new-category-box').getBoundingClientRect();return [...document.querySelectorAll('#new-category-box button')].map(el=>{const r=el.getBoundingClientRect();return r.left>=box.left && r.right<=box.right && r.top>=box.top && r.bottom<=box.bottom;});});
    check('Botones de categoría contenidos dentro del formulario',bounds.length===2 && bounds.every(Boolean));
    await page.screenshot({path:path.join(out,'categoria.png')});
    await page.type('#new-category-input','Venta por peso');await page.click('#new-category-box .btn-primary');
    await page.waitForFunction(()=>document.getElementById('mp-categoria').value==='Venta por peso' && document.getElementById('new-category-box').classList.contains('hidden'));
    check('Nueva categoría se guarda y queda seleccionada',true);
    const ids=await page.evaluate(async()=>{
      closeAllModals();
      const ids=[];for(const unit of ['kg','lb','g']){
        const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${DB.authToken}`},body:JSON.stringify({codigo:`MANUAL-${unit}`,nombre:`Peso manual ${unit}`,categoria:'Venta por peso',unidad:unit,saleMode:'peso',precioCompra:1,precioVenta:100,stock:10,stockMin:0,estado:'Activo',aplicaItbis:false})});
        const product=await r.json();if(!r.ok)throw new Error(JSON.stringify(product));DB.productos.push(product);ids.push(product.id);
      }
      DB.config.scaleType='none';DB.config.weightTotalEditEnabled=false;showModule('ventas');return ids;
    });
    for(const id of ids){
      const count=await page.evaluate(()=>DB.saleItems.length);
      await page.evaluate(id=>{void addProductById(id);},id);await page.waitForSelector('#sale-scale-manual-weight');
      if (count===0) await page.screenshot({path:path.join(out,'peso-manual.png')});
      await page.type('#sale-scale-manual-weight','0');
      check('Peso cero no se puede confirmar',await page.$eval('#sale-scale-confirm-btn',el=>el.disabled));
      await page.$eval('#sale-scale-manual-weight',el=>{el.value='0.5';el.dispatchEvent(new Event('input'));});
      await page.keyboard.press('Enter');await page.waitForFunction(n=>DB.saleItems.length===n+1,{},count);
    }
    const lines=await page.evaluate(()=>DB.saleItems.map(p=>({qty:p.qty,total:p.total,source:p.scaleSource,unit:p.weightUnit})));
    check('Sin báscula: 0.5 kg, lb y g calculan RD$50 cada uno',lines.length===3 && lines.every(p=>p.qty===0.5 && p.total===50 && p.source==='manual'),JSON.stringify(lines));
    await page.evaluate(()=>{void reweighSaleItem(0);});await page.waitForSelector('#sale-scale-manual-weight');
    await page.type('#sale-scale-manual-weight','0.75');await page.keyboard.press('Enter');await page.waitForFunction(()=>DB.saleItems[0].qty===0.75);
    check('Editar el peso recalcula el importe',await page.evaluate(()=>DB.saleItems[0].total===75));
    await page.evaluate(()=>{void reweighSaleItem(0);});await page.waitForSelector('#sale-scale-manual-weight');
    await page.type('#sale-scale-manual-weight','99');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.getElementById('sale-scale-manual-weight'));
    check('No permite aumentar el peso por encima del stock',await page.evaluate(()=>DB.saleItems[0].qty===0.75));
    await page.evaluate(()=>{void reweighSaleItem(0);});await page.waitForSelector('#sale-scale-manual-weight');
    await page.type('#sale-scale-manual-weight','1');
    await page.$eval('#sale-scale-manual-weight',el=>{el.value='0.001';el.dispatchEvent(new Event('input'));});
    check('Un peso que redondea a cero invalida la lectura anterior',await page.$eval('#sale-scale-confirm-btn',el=>el.disabled));
    await page.evaluate(()=>closeSaleScaleDialog());
    check('Cancelar conserva el peso anterior',await page.evaluate(()=>DB.saleItems[0].qty===0.75));
    await page.screenshot({path:path.join(out,'carrito.png')});
    const response=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname==='/api/sales');
    await page.evaluate(()=>openBillingModal());
    await page.waitForFunction(()=>document.getElementById('billing-total') || document.querySelector('.billing-modal'));
    await page.evaluate(()=>setMontoExacto());await page.evaluate(()=>processSale('charge'));
    const saleResponse=await response;const sale=await saleResponse.json();
    check('Cobro sin báscula: RD$175',saleResponse.ok() && Number(sale.sale?.total)===175,JSON.stringify(sale).slice(0,200));
    const products=await page.evaluate(async()=>{const r=await fetch('/api/products',{headers:{Authorization:`Bearer ${DB.authToken}`}});const j=await r.json();return Array.isArray(j)?j:j.products;});
    check('Inventario descuenta los pesos ingresados',ids.every((id,i)=>Number(products.find(p=>p.id===id)?.stock)===(i===0?9.25:9.5)));
    check('Sin errores de página',errors.length===0,errors.join('\n'));
  }catch(e){console.error(e.stack);process.exitCode=1;}finally{if(browser)await browser.close();if(server)await L.stopServer(server);}
})();
