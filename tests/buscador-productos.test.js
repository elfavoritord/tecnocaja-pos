// Buscador de productos de la venta (js/buscador-productos.js).
const { buscar, normalizar, distancia } = require('../js/buscador-productos');

let id = 0;
const producto = (nombre, codigo, categoria = 'General', extra = {}) => ({ id: ++id, nombre, codigo, categoria, ...extra });

// Los de la captura de GRUPO DUPAAL SRL y otros de colmado.
const catalogo = [
  producto('.PLATO DEL DIA GENERICO', '.PLATO DEL DIA GENERICO', 'COMIDA RAPIDA'),
  producto('1/2 POLLO AL HORNO', '1/2 POLLO AL HORNO'),
  producto('1/4 POLLO ROSTIZADO', '1/4 POLLO ROSTIZADO'),
  producto('10 PECHURINAS CON YU- TOS', '10 PECHURINAS CON YU- TOS'),
  producto('2 PIEZAS PECHURINAS YU-TOS', '2 PIEZAS PECHURINAS YU-TOS'),
  producto('3 PECHURINAS CON YU -TOS', '3 PECHURINAS CON YU -TOS'),
  producto('POLLO ENTERO', 'P-001'),
  producto('PIÑA COLADA', '7501001'),
  producto('Jugo de Piña Rica 1L', '7461234500017', 'Bebidas', { marca: 'Rica' }),
  producto('Galletas de soda', '7460000000011', 'Galletas'),
  producto('Arroz Selecto 5 lb', '7460000000028', 'Granos'),
  producto('Café Santo Domingo 1 lb', '7460000000035', 'Cafe', { marca: 'Induveca' }),
];

const nombres = (texto, opciones) => buscar(catalogo, texto, opciones).resultados.map((p) => p.nombre);

describe('normalizar', () => {
  test('quita acentos, mayúsculas y signos', () => {
    expect(normalizar('PIÑA  Colada')).toBe('pina colada');
    expect(normalizar('YU- TOS')).toBe('yu tos');
    expect(normalizar('1/2 POLLO')).toBe('1 2 pollo');
    expect(normalizar(null)).toBe('');
  });
});

describe('buscar', () => {
  test('los que empiezan por lo escrito salen primero, no el orden del catálogo', () => {
    const lista = nombres('p');
    // POLLO ENTERO también tiene el código con P (desempata); ".PLATO DEL DIA"
    // empieza por p sin el punto; "1/2 POLLO" va después.
    expect(lista.slice(0, 3)).toEqual(['POLLO ENTERO', 'PIÑA COLADA', '.PLATO DEL DIA GENERICO']);
    expect(lista.indexOf('POLLO ENTERO')).toBeLessThan(lista.indexOf('1/2 POLLO AL HORNO'));
    // Una sola letra no busca dentro de las palabras ("COMIDA RAPIDA", "Café Santo").
    expect(lista).not.toContain('Café Santo Domingo 1 lb');
  });

  test('las palabras en cualquier orden y a medias', () => {
    expect(nombres('pollo horno')[0]).toBe('1/2 POLLO AL HORNO');
    expect(nombres('horno pollo')[0]).toBe('1/2 POLLO AL HORNO');
    expect(nombres('pech yut')).toEqual(expect.arrayContaining([
      '10 PECHURINAS CON YU- TOS', '2 PIEZAS PECHURINAS YU-TOS', '3 PECHURINAS CON YU -TOS',
    ]));
    expect(nombres('rosti')).toEqual(['1/4 POLLO ROSTIZADO']);
  });

  test('sin acentos ni signos', () => {
    expect(nombres('pina')).toEqual(expect.arrayContaining(['PIÑA COLADA', 'Jugo de Piña Rica 1L']));
    expect(nombres('cafe')[0]).toBe('Café Santo Domingo 1 lb');
    expect(nombres('yutos')).toHaveLength(3);
    expect(nombres('yu tos')).toHaveLength(3);
  });

  test('el nombre que empieza así va antes que el que lo tiene en medio', () => {
    expect(nombres('pollo')).toEqual(['POLLO ENTERO', '1/2 POLLO AL HORNO', '1/4 POLLO ROSTIZADO']);
  });

  test('la palabra del producto cuenta sin el número del principio; empates en orden natural', () => {
    expect(nombres('pechurinas')).toEqual([
      '3 PECHURINAS CON YU -TOS', '10 PECHURINAS CON YU- TOS', '2 PIEZAS PECHURINAS YU-TOS',
    ]);
  });

  test('mismo comienzo de código: desempata el nombre', () => {
    const lista = [
      producto('2 PIEZAS PECHURINAS', 'PECH-2'),
      producto('3 PECHURINAS', 'PECH-3'),
    ];
    const r = buscar(lista, 'pech');
    expect(r.resultados.map((p) => p.nombre)).toEqual(['3 PECHURINAS', '2 PIEZAS PECHURINAS']);
    expect(r.sugerirPrimero).toBe(true);
  });

  test('mal escrito: sale el que más se parece, marcado como parecido', () => {
    const r = buscar(catalogo, 'polo');
    expect(r.resultados.map((p) => p.nombre)).toEqual(expect.arrayContaining(['POLLO ENTERO']));
    expect(r.soloParecidos).toBe(true);
    expect(r.sugerirPrimero).toBe(true);
    expect(nombres('pechurnas')).toHaveLength(3);
    expect(nombres('galetas')[0]).toBe('Galletas de soda');
  });

  test('un código escaneado: exacto primero y nunca "parecidos"', () => {
    const r = buscar(catalogo, '7460000000011');
    expect(r.resultados[0].nombre).toBe('Galletas de soda');
    expect(r.coincidencias[0].por).toBe('codigo');
    expect(r.sugerirPrimero).toBe(false);
    // Un código que no existe (a un dígito de otro) no trae nada: así se ofrece crearlo.
    expect(buscar(catalogo, '7460000000012').total).toBe(0);
  });

  test('un código a medias trae los que empiezan así, sin marcar ninguno', () => {
    const r = buscar(catalogo, '746000');
    expect(r.total).toBe(3);
    expect(r.sugerirPrimero).toBe(false);
  });

  test('categoría y marca cuentan, pero después del nombre', () => {
    expect(nombres('rica')[0]).toBe('Jugo de Piña Rica 1L');
    expect(nombres('induveca')).toEqual(['Café Santo Domingo 1 lb']);
    expect(nombres('granos')).toEqual(['Arroz Selecto 5 lb']);
  });

  test('todos los que coinciden, con límite y total', () => {
    const r = buscar(catalogo, 'p', { limite: 2 });
    expect(r.resultados).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
  });

  test('filtro (inactivos fuera) y nombre traducido', () => {
    const lista = [
      producto('Pollo frito', 'A1', 'General', { estado: 'inactivo' }),
      producto('Pollo guisado', 'A2'),
    ];
    const r = buscar(lista, 'pollo', { filtro: (p) => p.estado !== 'inactivo' });
    expect(r.resultados.map((p) => p.nombre)).toEqual(['Pollo guisado']);
    const traducido = buscar(lista, 'chicken', { nombreLocal: (p) => p.nombre.replace('Pollo', 'Chicken'), idioma: 'en' });
    expect(traducido.total).toBe(2);
  });

  test('el índice se rehace si cambia el nombre', () => {
    const p = producto('Refresco rojo', 'R1');
    expect(buscar([p], 'rojo').total).toBe(1);
    p.nombre = 'Refresco verde';
    expect(buscar([p], 'rojo').total).toBe(0);
    expect(buscar([p], 'verde').total).toBe(1);
  });

  test('vacío o solo signos no rompe', () => {
    expect(buscar(catalogo, '').total).toBe(0);
    expect(buscar(catalogo, '   ').total).toBe(0);
    expect(() => buscar(catalogo, '/')).not.toThrow();
    expect(buscar(null, 'pollo').total).toBe(0);
  });

  // Solo para atajar algo desproporcionado (esta PC de pruebas es lenta y varía).
  test('no se dispara con un catálogo grande', () => {
    const grande = [];
    for (let i = 0; i < 5000; i += 1) grande.push(producto(`Producto ${i} sabor ${i % 7 ? 'fresa' : 'uva'}`, `C${i}`));
    buscar(grande, 'a'); // arma el índice
    const inicio = Date.now();
    for (const texto of ['p', 'pro', 'producto 123', 'fresa', 'frsa', 'zzzz']) buscar(grande, texto, { limite: 50 });
    expect(Date.now() - inicio).toBeLessThan(3000);
  });
});

describe('distancia', () => {
  test('cuenta los errores y se corta al pasar del máximo', () => {
    expect(distancia('polo', 'poll', 1)).toBe(1);
    expect(distancia('galetas', 'galletas', 2)).toBe(1);
    expect(distancia('arroz', 'arorz', 1)).toBe(1); // letras cambiadas de lugar
    expect(distancia('soda', 'pollo', 1)).toBe(2);
  });
});
