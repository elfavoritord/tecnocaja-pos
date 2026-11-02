'use strict';

const {
  SECCIONES, ESTILOS, normalizarDiseno, aplicarEstilo, resolverDiseno,
} = require('../../server/tienda-online/diseno');

const idsEnOrden = (d) => d.secciones.map((s) => s.id);

describe('diseño de la tienda', () => {
  test('sin nada guardado queda Moderno, completo y válido', () => {
    for (const entrada of [undefined, null, 'x', 5, [], {}]) {
      const d = normalizarDiseno(entrada);
      expect(d.estilo).toBe('moderno');
      expect(d.apariencia.temaOscuro).toBe(true);
      expect(d.secciones.map((s) => s.id).sort()).toEqual(SECCIONES.map((s) => s.id).sort());
    }
  });

  test('una tienda de antes conserva su color', () => {
    const d = resolverDiseno(undefined, { colorPrimario: '#047857' });
    expect(d.colores.principal).toBe('#047857');
    expect(d.colores.botones).toBe('#047857');
  });

  test('un color inválido se cambia por el del estilo; no se guarda basura', () => {
    const d = normalizarDiseno({ colores: { fondo: 'url(evil)', texto: '#GGGGGG', pie: '#123456', tarjetas: 12 } });
    expect(d.colores.fondo).toBe(ESTILOS.moderno.colores.fondo);
    expect(d.colores.texto).toBe(ESTILOS.moderno.colores.texto);
    expect(d.colores.pie).toBe('#123456');
    expect(d.colores.tarjetas).toBe(ESTILOS.moderno.colores.tarjetas);
  });

  test('las opciones fuera de la lista se ignoran', () => {
    const d = normalizarDiseno({ apariencia: { tipografia: 'comic', esquinas: '"><script>' }, hero: { altura: 9999 } });
    expect(d.apariencia.tipografia).toBe('inter');
    expect(d.apariencia.esquinas).toBe('redondas');
    expect(d.hero.altura).toBe('media');
  });

  test('un estilo que no existe no rompe (ni "__proto__")', () => {
    expect(normalizarDiseno({ estilo: '__proto__' }).estilo).toBe('moderno');
    expect(normalizarDiseno({ estilo: 'constructor' }).estilo).toBe('moderno');
  });

  test('los enlaces solo aceptan lugares de la tienda o https', () => {
    const enlace = (v) => normalizarDiseno({ hero: { enlaceBoton: v } }).hero.enlaceBoton;
    expect(enlace('ofertas')).toBe('ofertas');
    expect(enlace('categoria:Bebidas')).toBe('categoria:Bebidas');
    expect(enlace('https://mi-negocio.do/a')).toBe('https://mi-negocio.do/a');
    expect(enlace('javascript:alert(1)')).toBe('catalogo');
    expect(enlace('JaVaScRiPt:alert(1)')).toBe('catalogo');
    expect(enlace('data:text/html,x')).toBe('catalogo');
    expect(enlace('http://sin-candado.do')).toBe('catalogo');
    expect(enlace('https://a.do/"onmouseover="x')).toBe('catalogo');
    const redes = normalizarDiseno({ redes: { facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/x' } }).redes;
    expect(redes.facebook).toBe('');
    expect(redes.instagram).toBe('https://instagram.com/x');
  });

  test('los textos se recortan', () => {
    const d = normalizarDiseno({ hero: { titulo: 'x'.repeat(500), subtitulo: 'y'.repeat(900) }, secciones: [{ id: 'ofertas', titulo: 'z'.repeat(200) }] });
    expect(d.hero.titulo).toHaveLength(90);
    expect(d.hero.subtitulo).toHaveLength(200);
    expect(d.secciones.find((s) => s.id === 'ofertas').titulo).toHaveLength(60);
  });

  test('el orden elegido se respeta exactamente, con encabezado y pie en sus puntas', () => {
    const medio = ['catalogo', 'ofertas', 'hero', 'marcas', 'categorias', 'destacados', 'nuevos', 'masVendidos', 'banners', 'informacion', 'contacto'];
    const d = normalizarDiseno({ secciones: [{ id: 'pie' }, ...medio.map((id) => ({ id })), { id: 'encabezado' }] });
    expect(idsEnOrden(d)).toEqual(['encabezado', ...medio, 'pie']);
  });

  test('secciones repetidas o inventadas se descartan, y las que falten vuelven', () => {
    const d = normalizarDiseno({ secciones: [{ id: 'hero' }, { id: 'hero' }, { id: 'hackeada' }, { id: 'ofertas', activa: false }] });
    expect(idsEnOrden(d).filter((id) => id === 'hero')).toHaveLength(1);
    expect(idsEnOrden(d)).not.toContain('hackeada');
    expect(idsEnOrden(d)).toHaveLength(SECCIONES.length);
    expect(d.secciones.find((s) => s.id === 'ofertas').activa).toBe(false);
  });

  test('todos los productos no se pueden apagar', () => {
    const d = normalizarDiseno({ secciones: [{ id: 'catalogo', activa: false }] });
    expect(d.secciones.find((s) => s.id === 'catalogo').activa).toBe(true);
  });

  test('elegir un estilo cambia el aspecto y conserva los textos del negocio', () => {
    const antes = normalizarDiseno({
      hero: { titulo: 'Mi portada' },
      redes: { instagram: 'https://instagram.com/x' },
      apariencia: { temaOscuro: false },
      secciones: [{ id: 'ofertas', titulo: 'Solo hoy' }],
    });
    const d = aplicarEstilo('premium', antes);
    expect(d.estilo).toBe('premium');
    expect(d.apariencia.esquinas).toBe('rectas');
    expect(d.colores.fondo).toBe(ESTILOS.premium.colores.fondo);
    expect(d.hero.titulo).toBe('Mi portada');
    expect(d.redes.instagram).toBe('https://instagram.com/x');
    expect(d.apariencia.temaOscuro).toBe(false);
    expect(d.secciones.find((s) => s.id === 'ofertas').titulo).toBe('Solo hoy');
  });

  test('los tres estilos son válidos tal cual', () => {
    for (const id of Object.keys(ESTILOS)) {
      const d = aplicarEstilo(id, {});
      expect(normalizarDiseno(d)).toEqual(d);
    }
  });
});
