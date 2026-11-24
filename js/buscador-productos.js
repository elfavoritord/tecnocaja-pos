/* ═══════════════════════════════════════════════════════════════════════════
   TECNO CAJA — Buscador de productos de la venta

   Pedido de Emilio (2026-11-23): que el producto salga rápido escribiendo solo
   un pedazo del nombre, que salgan todos los que coinciden o el que más se
   parece, sin tener que escribir el nombre completo.

   Antes el buscador (_doSearchProduct en js/ventas.js) buscaba el texto tal
   cual dentro del nombre, el código, la categoría o la marca, y mostraba los
   8 primeros en el orden del catálogo (alfabético). Con "p" salían ".PLATO
   DEL DIA" y "1/2 POLLO" antes que los que empiezan por P; "pollo horno" no
   encontraba "1/2 POLLO AL HORNO"; "pina" no encontraba "PIÑA"; "yutos" no
   encontraba "YU- TOS"; y con varios resultados Enter no agregaba nada, así
   que había que escribir hasta dejar uno solo.

   Ahora:
     - Sin acentos, mayúsculas ni signos: "pina" = "PIÑA", "yu tos" = "YU-TOS".
     - Cada palabra escrita se busca por separado y en cualquier orden:
       "pollo horno" encuentra "1/2 POLLO AL HORNO". "pech yut" también.
     - Se ordena por parecido: código igual, nombre igual, nombre que empieza
       así, palabras que empiezan así, palabras que lo contienen y, al final,
       lo que solo coincide por categoría o marca.
     - Si no hay casi nada, también salen los que se escribieron con un error
       ("polo" → POLLO, "pechurnas" → PECHURINAS). Solo con palabras de letras
       de 4 o más: un código escaneado nunca se "parece" a otro.
     - El índice de cada producto se arma una vez y se rehace solo si cambia
       su nombre, código, categoría, marca o el idioma.

   Lo usan el buscador de la venta y el catálogo de la pantalla dividida
   (js/ventas.js). Sin DOM: se prueba con Jest (tests/buscador-productos.test.js).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuscadorProductos = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Puntos. Lo que coincide por código o por el nombre entero siempre va
  // primero; después cuenta cada palabra escrita.
  const PUNTOS = {
    codigoIgual: 10000,
    nombreIgual: 9000,
    nombreEmpieza: 7000,
    codigoEmpieza: 6000,
    palabras: 1000,
    codigoContiene: 900, // un pedazo del medio del código: después de los nombres
  };
  // Lo que suma cada palabra escrita según dónde apareció.
  const PALABRA = {
    igual: 120,       // es una palabra entera del nombre
    empieza: 100,     // una palabra del nombre empieza así
    dentro: 45,       // está dentro de una palabra o del nombre sin espacios
    extraEmpieza: 25, // categoría, marca o código
    extraDentro: 12,
    parecida: 30,     // con un error de escritura (se le resta por error)
  };
  // Si lo exacto da menos que esto, se buscan también los parecidos.
  const MINIMO_SIN_PARECIDOS = 10;

  const DIACRITICOS = /[\u0300-\u036f]/g;
  const NO_ALFANUMERICO = /[^\p{L}\p{N}]+/gu;
  const TIENE_LETRA = /\p{L}/u;
  const SOLO_LETRAS = /^\p{L}+$/u;

  function normalizar(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD')
      .replace(DIACRITICOS, '')
      .toLowerCase()
      .replace(NO_ALFANUMERICO, ' ')
      .trim();
  }

  function palabrasDe(normalizado) {
    return normalizado ? normalizado.split(' ') : [];
  }

  // Clave para ordenar empates: alfabético, pero "2 PIEZAS" antes que "10 PECHURINAS".
  function claveOrden(normalizado) {
    return normalizado.replace(/\d+/g, (n) => n.padStart(8, '0'));
  }

  // ── Índice por producto ────────────────────────────────────────────────────
  const indices = new WeakMap();

  function indiceDe(producto, opciones) {
    const idioma = opciones.idioma || '';
    const guardado = indices.get(producto);
    if (guardado
      && guardado.nombreCrudo === producto.nombre
      && guardado.codigoCrudo === producto.codigo
      && guardado.categoriaCruda === producto.categoria
      && guardado.marcaCruda === producto.marca
      && guardado.idioma === idioma) {
      return guardado;
    }

    const nombre = normalizar(producto.nombre);
    const nombreLocal = opciones.nombreLocal ? normalizar(opciones.nombreLocal(producto)) : nombre;
    const categoriaLocal = opciones.categoriaLocal ? opciones.categoriaLocal(producto.categoria) : '';
    const codigo = String(producto.codigo == null ? '' : producto.codigo).trim().toLowerCase();

    const nombres = nombreLocal && nombreLocal !== nombre ? [nombre, nombreLocal] : [nombre];
    // Cada palabra con su lugar en el nombre sin contar los números del
    // principio: en "3 PECHURINAS" y "1/2 POLLO" la primera es la del producto.
    const palabrasNombre = [];
    const lugares = [];
    nombres.forEach((n) => {
      let lugar = 0;
      palabrasDe(n).forEach((p) => {
        palabrasNombre.push(p);
        lugares.push(lugar);
        if (!/^\d+$/.test(p)) lugar += 1;
      });
    });
    const extra = normalizar([producto.categoria, categoriaLocal, producto.marca, codigo].filter(Boolean).join(' '));

    const indice = {
      nombreCrudo: producto.nombre,
      codigoCrudo: producto.codigo,
      categoriaCruda: producto.categoria,
      marcaCruda: producto.marca,
      idioma,
      nombres,
      palabrasNombre,
      lugares,
      compactos: nombres.map((n) => n.replace(/ /g, '')),
      codigo,
      palabrasExtra: palabrasDe(extra),
      orden: claveOrden(nombreLocal || nombre),
    };
    indices.set(producto, indice);
    return indice;
  }

  // ── Errores de escritura ───────────────────────────────────────────────────
  // Distancia de edición (con letras cambiadas de lugar) que se corta en cuanto
  // pasa de `maximo`: así casi no cuesta cuando las palabras no se parecen.
  function distancia(a, b, maximo) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > maximo) return maximo + 1;
    let antesDeAyer = null;
    let ayer = new Array(lb + 1);
    for (let j = 0; j <= lb; j += 1) ayer[j] = j;
    for (let i = 1; i <= la; i += 1) {
      const hoy = new Array(lb + 1);
      hoy[0] = i;
      let menor = i;
      for (let j = 1; j <= lb; j += 1) {
        const costo = a[i - 1] === b[j - 1] ? 0 : 1;
        let valor = Math.min(ayer[j] + 1, hoy[j - 1] + 1, ayer[j - 1] + costo);
        if (antesDeAyer && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          valor = Math.min(valor, antesDeAyer[j - 2] + 1);
        }
        hoy[j] = valor;
        if (valor < menor) menor = valor;
      }
      if (menor > maximo) return maximo + 1;
      antesDeAyer = ayer;
      ayer = hoy;
    }
    return ayer[lb];
  }

  // Errores que se aceptan según el largo de lo escrito (0 = no se intenta).
  function erroresPermitidos(palabra) {
    if (palabra.length < 4 || !SOLO_LETRAS.test(palabra)) return 0;
    return palabra.length >= 7 ? 2 : 1;
  }

  // Compara lo escrito con la palabra entera y con su comienzo (se pudo haber
  // escrito solo un pedazo, y con un error).
  function errorContraPalabra(escrita, palabra, maximo) {
    let mejor = maximo + 1;
    const desde = Math.max(1, escrita.length - maximo);
    const hasta = Math.min(palabra.length, escrita.length + maximo);
    for (let largo = desde; largo <= hasta; largo += 1) {
      const d = distancia(escrita, largo === palabra.length ? palabra : palabra.slice(0, largo), maximo);
      if (d < mejor) mejor = d;
      if (mejor === 0) break;
    }
    return mejor;
  }

  // ── Puntaje de un producto ─────────────────────────────────────────────────
  function puntuarPalabra(escrita, indice, conParecidos, memoria) {
    const corta = escrita.length < 2;
    let mejor = null;
    const palabras = indice.palabrasNombre;
    for (let i = 0; i < palabras.length; i += 1) {
      const palabra = palabras[i];
      let puntos = 0;
      if (palabra === escrita) puntos = PALABRA.igual;
      else if (palabra.startsWith(escrita)) puntos = PALABRA.empieza;
      else if (!corta && palabra.includes(escrita)) puntos = PALABRA.dentro;
      if (puntos) {
        // Mejor si está entre las primeras palabras del nombre.
        const lugar = indice.lugares[i];
        puntos += lugar === 0 ? 15 : lugar === 1 ? 8 : lugar === 2 ? 4 : 0;
        if (!mejor || puntos > mejor.puntos) mejor = { puntos, posicion: i, por: 'nombre' };
      }
    }
    if (mejor) return mejor;

    // "yutos" en "YU- TOS": el nombre sin espacios ni signos.
    if (escrita.length >= 3 && indice.compactos.some((c) => c.includes(escrita))) {
      return { puntos: PALABRA.dentro, posicion: -1, por: 'nombre' };
    }

    for (const palabra of indice.palabrasExtra) {
      if (palabra.startsWith(escrita)) return { puntos: PALABRA.extraEmpieza, posicion: -1, por: 'extra' };
    }
    if (escrita.length >= 3) {
      for (const palabra of indice.palabrasExtra) {
        if (palabra.includes(escrita)) return { puntos: PALABRA.extraDentro, posicion: -1, por: 'extra' };
      }
    }

    const maximo = conParecidos ? erroresPermitidos(escrita) : 0;
    if (!maximo) return null;
    // Muchas palabras se repiten entre productos ("pollo", "lb"…): cada una se
    // compara una sola vez por búsqueda.
    let yaComparadas = memoria.get(escrita);
    if (!yaComparadas) {
      yaComparadas = new Map();
      memoria.set(escrita, yaComparadas);
    }
    let parecida = null;
    for (let i = 0; i < palabras.length; i += 1) {
      const palabra = palabras[i];
      if (palabra.length < escrita.length - maximo) continue;
      let errores = yaComparadas.get(palabra);
      if (errores === undefined) {
        errores = errorContraPalabra(escrita, palabra, maximo);
        yaComparadas.set(palabra, errores);
      }
      if (errores <= maximo && (!parecida || errores < parecida.errores)) {
        parecida = { puntos: PALABRA.parecida - errores * 10, posicion: i, por: 'nombre', errores, aproximado: true };
      }
    }
    return parecida;
  }

  function puntuar(indice, consulta, conParecidos) {
    let puntosCodigo = 0;
    if (indice.codigo) {
      if (indice.codigo === consulta.cruda) puntosCodigo = PUNTOS.codigoIgual;
      else if (indice.codigo.startsWith(consulta.cruda)) puntosCodigo = PUNTOS.codigoEmpieza;
      else if (consulta.cruda.length >= 3 && indice.codigo.includes(consulta.cruda)) puntosCodigo = PUNTOS.codigoContiene;
    }

    let puntosNombre = 0;
    let por = '';
    let aproximado = false;
    if (indice.nombres.includes(consulta.normalizada)) {
      puntosNombre = PUNTOS.nombreIgual;
      por = 'nombre';
    } else if (indice.nombres.some((n) => n.startsWith(consulta.normalizada))) {
      puntosNombre = PUNTOS.nombreEmpieza;
      por = 'nombre';
    } else {
      let suma = 0;
      let enNombre = false;
      let ultimaPosicion = -1;
      let enOrden = true;
      for (const escrita of consulta.palabras) {
        const resultado = puntuarPalabra(escrita, indice, conParecidos, consulta.memoria);
        if (!resultado) { suma = -1; break; }
        suma += resultado.puntos;
        if (resultado.por === 'nombre') enNombre = true;
        if (resultado.aproximado) aproximado = true;
        if (resultado.posicion >= 0) {
          if (resultado.posicion < ultimaPosicion) enOrden = false;
          ultimaPosicion = resultado.posicion;
        }
      }
      if (suma >= 0) {
        puntosNombre = PUNTOS.palabras + suma + (enOrden && consulta.palabras.length > 1 ? 20 : 0);
        por = enNombre ? 'nombre' : 'extra';
      }
    }

    if (!puntosCodigo && !puntosNombre) return null;
    // Lo que coincidió por nombre (aunque también por código): Enter puede
    // agregarlo. Solo por código, no (un código a medias no es "el parecido").
    const porNombre = por === 'nombre';
    // El otro puntaje desempata: con el mismo código "PECH-…", va primero el
    // nombre que más se parece.
    const mayor = Math.max(puntosCodigo, puntosNombre);
    const desempate = Math.min(puntosCodigo, puntosNombre) / 10000;
    if (puntosCodigo >= puntosNombre) return { puntos: mayor + desempate, por: 'codigo', porNombre, aproximado: false };
    return { puntos: mayor + desempate, por, porNombre, aproximado };
  }

  function prepararConsulta(texto) {
    const cruda = String(texto == null ? '' : texto).trim().toLowerCase();
    const normalizada = normalizar(cruda);
    return {
      cruda,
      normalizada,
      palabras: palabrasDe(normalizada),
      tieneLetra: TIENE_LETRA.test(cruda),
      memoria: new Map(),
    };
  }

  /**
   * Busca en `productos` lo que se escribió, del más parecido al menos.
   *
   * opciones:
   *   limite          cuántos devolver (sin límite si no se pasa)
   *   filtro(p)       solo cuenta los productos que devuelven true
   *   nombreLocal(p)  nombre traducido (también se busca por él)
   *   categoriaLocal(c)
   *   idioma          si cambia, se rehace el índice
   *
   * Devuelve { resultados, coincidencias, total, soloParecidos, sugerirPrimero }:
   *   coincidencias   [{ producto, puntos, por: 'codigo'|'nombre'|'extra', porNombre, aproximado }]
   *   total           cuántos coinciden en total (aunque se devuelvan menos)
   *   soloParecidos   no hubo ninguno exacto: todo lo que salió es "parecido"
   *   sugerirPrimero  el primero se buscó por nombre: Enter puede agregarlo
   */
  function buscar(productos, texto, opciones = {}) {
    const consulta = prepararConsulta(texto);
    const vacio = { resultados: [], coincidencias: [], total: 0, soloParecidos: false, sugerirPrimero: false };
    if (!consulta.cruda || !Array.isArray(productos)) return vacio;
    // Solo signos ("/", "-"): se busca tal cual en el código.
    if (!consulta.palabras.length) consulta.palabras = [consulta.cruda];

    const filtro = typeof opciones.filtro === 'function' ? opciones.filtro : null;
    const candidatos = [];
    let coincidencias = [];
    for (const producto of productos) {
      if (!producto || (filtro && !filtro(producto))) continue;
      const indice = indiceDe(producto, opciones);
      const resultado = puntuar(indice, consulta, false);
      if (resultado) coincidencias.push({ producto, indice, ...resultado });
      else candidatos.push({ producto, indice });
    }

    if (coincidencias.length < MINIMO_SIN_PARECIDOS
      && consulta.palabras.some((p) => erroresPermitidos(p) > 0)) {
      for (const candidato of candidatos) {
        const resultado = puntuar(candidato.indice, consulta, true);
        if (resultado) coincidencias.push({ ...candidato, ...resultado });
      }
    }

    // Los escritos bien siempre antes que los "parecidos".
    coincidencias.sort((a, b) => (a.aproximado === b.aproximado ? 0 : a.aproximado ? 1 : -1)
      || (b.puntos - a.puntos)
      || (a.indice.orden < b.indice.orden ? -1 : a.indice.orden > b.indice.orden ? 1 : 0));

    const total = coincidencias.length;
    const limite = Number(opciones.limite);
    if (Number.isFinite(limite) && limite > 0 && coincidencias.length > limite) {
      coincidencias = coincidencias.slice(0, limite);
    }
    const lista = coincidencias.map(({ producto, puntos, por, porNombre, aproximado }) => ({ producto, puntos, por, porNombre, aproximado }));
    const primero = lista[0];
    return {
      resultados: lista.map((c) => c.producto),
      coincidencias: lista,
      total,
      soloParecidos: total > 0 && lista.every((c) => c.aproximado),
      // Solo cuando se escribió un nombre: un código escaneado que no existe
      // nunca deja marcado otro producto para que Enter lo agregue.
      sugerirPrimero: Boolean(primero && consulta.tieneLetra && primero.porNombre),
    };
  }

  // Arma el índice antes de la primera búsqueda (con miles de productos, la
  // primera tecla no espera). Los que ya están al día casi no cuestan.
  function preparar(productos, opciones = {}) {
    if (!Array.isArray(productos)) return;
    for (const producto of productos) if (producto) indiceDe(producto, opciones);
  }

  return {
    buscar,
    preparar,
    normalizar,
    distancia,
  };
});
