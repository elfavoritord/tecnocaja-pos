/* Catálogo de permisos que se pueden dar a cada usuario. Lo usan el servidor
   (server/security/permisos-usuario.js) y la pantalla (js/app.js, js/clientes.js).
   Los códigos son los que el sistema YA revisa (roles.permisos, requirePermission
   de compras/gastos, atajos de caja), no nombres nuevos.

   Un usuario sin lista propia (users.permisos_usuario = NULL) sigue con lo de su
   rol exactamente como antes; con lista propia, puede justo lo que tiene marcado.
   El administrador general siempre puede todo y no se personaliza. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PermisosCatalogo = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const GRUPOS = [
    { id: 'ventas', titulo: 'Ventas y caja', permisos: [
      ['ventas', 'Vender', 'Pantalla de ventas: agregar productos, cobrar y facturar.'],
      ['caja', 'Caja', 'Pantalla de caja, ingresos, egresos y cola de cobro.'],
      ['abrir_caja', 'Abrir caja', 'Iniciar el turno con el fondo.'],
      ['cerrar_caja', 'Cerrar caja', 'Contar y cerrar el turno.'],
      ['hacer_corte_caja', 'Corte y arqueo', 'Contar la gaveta sin cerrar el turno.'],
      ['abrir_gaveta', 'Abrir gaveta sin venta', 'Siempre con motivo registrado.'],
      ['anular_ventas', 'Cancelar facturas', 'Cancelación interna, anulación de NCF o nota de crédito por el total.'],
      ['devolver_ventas', 'Devoluciones y notas de crédito', 'Devolver productos de una factura cobrada.'],
      ['ver_reportes_caja', 'Ver el turno abierto', 'Montos de la caja abierta, historial de gaveta y Reportes con cierre seguro.'],
      ['ver_ganancias', 'Ver costos y ganancias', 'Costo de los productos y margen en reportes.'],
    ] },
    { id: 'clientes', titulo: 'Clientes', permisos: [
      ['clientes', 'Clientes y crédito', 'Fichas de clientes, cuentas por cobrar y abonos.'],
    ] },
    { id: 'productos', titulo: 'Productos e inventario', permisos: [
      ['productos', 'Productos', 'Crear y editar productos, categorías y etiquetas.'],
      ['inventario', 'Inventario', 'Existencias, ajustes y movimientos de inventario.'],
      ['promociones', 'Promociones', 'Ofertas y combos.'],
    ] },
    { id: 'compras', titulo: 'Compras y gastos', permisos: [
      ['compras.ver', 'Ver compras y suplidores', 'Consultar compras y la lista de suplidores.'],
      ['compras.crear', 'Registrar compras', 'Entradas de mercancía que suben el inventario.'],
      ['compras.anular', 'Anular compras', 'Revierte el inventario que generó la compra.'],
      ['compras.recibir', 'Recibir mercancía', 'Confirmar lo que llegó de una compra (si el negocio sube el inventario al recibir).'],
      ['cuentas_por_pagar.ver', 'Cuentas por pagar', 'Deudas con suplidores.'],
      ['cuentas_por_pagar.pagar', 'Pagar a suplidores', 'Registrar abonos a las facturas de suplidores.'],
      ['gastos.ver', 'Ver gastos', 'Consultar los gastos del negocio.'],
      ['gastos.crear', 'Registrar gastos', 'Gastos con sus líneas y comprobantes.'],
      ['gastos.anular', 'Anular gastos', 'Deja el gasto anulado con su motivo.'],
    ] },
    { id: 'reportes', titulo: 'Reportes', permisos: [
      ['reportes', 'Reportes', 'Ventas, ITBIS, propinas y estadísticas.'],
      ['auditoria_global', 'Movimientos y auditoría', 'Quién hizo qué y cuándo.'],
    ] },
    { id: 'administracion', titulo: 'Administración', permisos: [
      ['usuarios', 'Usuarios', 'Crear y editar usuarios.'],
      ['gestionar_configuracion_global', 'Configuración', 'Datos del negocio, facturación, comprobantes, periféricos y monedas.'],
      ['delivery', 'Delivery', 'Pedidos a domicilio y repartidores.'],
      ['rrhh', 'Recursos humanos', 'Empleados, asistencia y permisos.'],
      ['tiendaonline', 'Tienda online', 'Pedidos que llegan de la tienda.'],
    ] },
  ].map((g) => ({ ...g, permisos: g.permisos.map(([codigo, nombre, ayuda]) => ({ codigo, nombre, ayuda })) }));

  const CODIGOS = GRUPOS.flatMap((g) => g.permisos.map((p) => p.codigo));
  const VALIDOS = new Set(CODIGOS);

  // Módulo del menú → basta con uno de estos permisos para verlo. Los módulos
  // que no están aquí siguen la regla de siempre.
  const MODULOS = {
    ventas: ['ventas'], posmovil: ['ventas'], caja: ['caja'], colacobro: ['caja'], clientes: ['clientes'],
    productos: ['productos'], labels: ['productos'], inventario: ['inventario'], promociones: ['promociones'],
    compras: ['compras.ver', 'gastos.ver', 'cuentas_por_pagar.ver'], proveedores: ['compras.ver'],
    reportes: ['reportes'], movimientos: ['auditoria_global'], usuarios: ['usuarios'],
    configuracion: ['gestionar_configuracion_global'], monedas: ['gestionar_configuracion_global'], wabot: ['gestionar_configuracion_global'],
    delivery: ['delivery'], rrhh: ['rrhh'], tiendaonline: ['tiendaonline'],
  };

  // Lo que cada rol puede hacer hoy (su lista de la base más lo que le dan los
  // atajos por rol). Es el punto de partida al personalizar: quitar una casilla
  // no le quita otras cosas sin querer.
  const CAJA = ['caja', 'abrir_caja', 'cerrar_caja', 'hacer_corte_caja', 'abrir_gaveta'];
  const POR_ROL = {
    administrador_sucursal: ['ventas', ...CAJA, 'anular_ventas', 'devolver_ventas', 'ver_reportes_caja', 'ver_ganancias', 'clientes',
      'productos', 'inventario', 'promociones', 'reportes', 'usuarios', 'delivery', 'rrhh', 'tiendaonline'],
    supervisor: ['ventas', ...CAJA, 'anular_ventas', 'devolver_ventas', 'ver_reportes_caja', 'ver_ganancias', 'clientes',
      'inventario', 'promociones', 'reportes', 'delivery', 'tiendaonline'],
    cajero: ['ventas', ...CAJA, 'clientes', 'reportes', 'delivery', 'tiendaonline'],
    repartidor: ['delivery'],
  };
  // Códigos viejos de roles.permisos que equivalen a uno del catálogo.
  const EQUIVALENTES = { reportes_sucursal: 'reportes', ver_reportes_sucursal: 'reportes', gestionar_usuarios: 'usuarios', usuarios_crear: 'usuarios', crear_productos_globales: 'productos', editar_productos_globales: 'productos' };

  function normalizarRol(rol) {
    const r = String(rol || '').trim().toLowerCase();
    if (['administrador_general', 'administrador general', 'administrador', 'admin', 'admin general', 'admin_general', 'superadmin'].includes(r)) return 'administrador_general';
    if (r === 'administrador sucursal') return 'administrador_sucursal';
    if (r === 'delivery') return 'repartidor';
    return r || 'cajero';
  }
  // Lista limpia, sin repetidos y en el orden del catálogo.
  function normalizar(lista) {
    const dados = new Set((Array.isArray(lista) ? lista : []).map((c) => EQUIVALENTES[c] || c).filter((c) => VALIDOS.has(c)));
    return CODIGOS.filter((c) => dados.has(c));
  }
  function porDefecto(rol, permisosDelRol = []) {
    const codigo = normalizarRol(rol);
    if (codigo === 'administrador_general') return [...CODIGOS];
    return normalizar([...(POR_ROL[codigo] || []), ...(Array.isArray(permisosDelRol) ? permisosDelRol : [])]);
  }
  const iguales = (a, b) => { const x = normalizar(a), y = normalizar(b); return x.length === y.length && x.every((c, i) => c === y[i]); };
  function moduloPermitido(modulo, permisos) {
    const requeridos = MODULOS[modulo];
    if (!requeridos) return null; // sin regla propia: decide la lógica de siempre
    const tiene = new Set(permisos || []);
    return requeridos.some((p) => tiene.has(p));
  }
  return { GRUPOS, CODIGOS, MODULOS, POR_ROL, normalizar, normalizarRol, porDefecto, iguales, moduloPermitido, esValido: (c) => VALIDOS.has(c) };
});
