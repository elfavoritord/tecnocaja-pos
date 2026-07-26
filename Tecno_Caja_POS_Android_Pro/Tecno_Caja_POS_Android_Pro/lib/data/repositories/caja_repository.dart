import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/database_providers.dart';
import '../../core/utils/id_generator.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/venta.dart';
import '../local/daos/ventas_dao.dart';

class ResumenCierreCaja {
  const ResumenCierreCaja({
    required this.montoApertura,
    required this.totalVentasEfectivo,
    required this.totalVentasTarjeta,
    required this.totalVentasTransferencia,
    required this.totalVentasCredito,
    required this.totalEntradas,
    required this.totalSalidas,
    required this.totalGastos,
    required this.montoEsperado,
    required this.cantidadVentas,
  });

  final double montoApertura;
  final double totalVentasEfectivo;
  final double totalVentasTarjeta;
  final double totalVentasTransferencia;
  final double totalVentasCredito;
  final double totalEntradas;
  final double totalSalidas;
  final double totalGastos;
  final double montoEsperado;
  final int cantidadVentas;
}

class CajaRepository {
  CajaRepository(this._sesionDao, this._movimientoDao, this._ventaDao);

  final SesionCajaDao _sesionDao;
  final MovimientoCajaDao _movimientoDao;
  final VentaDao _ventaDao;

  Future<SesionCaja?> sesionAbiertaDe(String cajaId) =>
      _sesionDao.abiertaEn(cajaId);

  Future<SesionCaja?> sesionAbiertaDeUsuario(
    String usuarioId, {
    String? empresaId,
  }) async {
    final companyFilter = empresaId == null ? '' : ' AND empresa_id = ?';
    final sesiones = await _sesionDao.findAll(
      where: "usuario_apertura_id = ? AND estado = 'abierta'$companyFilter",
      whereArgs: [usuarioId, if (empresaId != null) empresaId],
      orderBy: 'abierta_en DESC',
      limit: 1,
    );
    return sesiones.isEmpty ? null : sesiones.first;
  }

  Future<SesionCaja> abrir({
    required String empresaId,
    required String sucursalId,
    required String cajaId,
    required String usuarioId,
    required double montoApertura,
    double? tasaCambioUsd,
    String? dispositivoId,
  }) async {
    final abiertaExistente = await _sesionDao.abiertaEn(cajaId);
    if (abiertaExistente != null) {
      throw const ValidationException(
          message: 'Esta caja ya tiene un turno abierto.');
    }

    final now = DateTime.now();
    final sesion = SesionCaja(
      id: IdGenerator.newId(),
      usuarioAperturaId: usuarioId,
      montoApertura: montoApertura,
      abiertaEn: now,
      tasaCambioUsd: tasaCambioUsd,
      empresaId: empresaId,
      sucursalId: sucursalId,
      cajaId: cajaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _sesionDao.insert(sesion);
    return sesion;
  }

  Future<SesionCaja> recuperarTurnoNube({
    required String empresaId,
    required String sucursalId,
    required String cajaId,
    required String usuarioId,
    required double montoApertura,
    required DateTime abiertaEn,
    required String dispositivoId,
  }) async {
    final existente = await _sesionDao.abiertaEn(cajaId);
    if (existente != null) return existente;
    final now = DateTime.now();
    final sesion = SesionCaja(
      id: IdGenerator.newId(),
      usuarioAperturaId: usuarioId,
      montoApertura: montoApertura,
      abiertaEn: abiertaEn,
      empresaId: empresaId,
      sucursalId: sucursalId,
      cajaId: cajaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _sesionDao.insert(sesion);
    return sesion;
  }

  Future<ResumenCierreCaja> calcularResumen(SesionCaja sesion) async {
    final ventas = await _ventaDao.deSesion(sesion.id);
    final movimientos = await _movimientoDao.deSesion(sesion.id);

    double efectivo = 0, tarjeta = 0, transferencia = 0, credito = 0;
    var cantidadVentas = 0;
    for (final venta in ventas) {
      if (venta.estado != EstadoVenta.completada) continue;
      cantidadVentas++;
      switch (venta.metodoPago) {
        case MetodoPago.efectivo:
          efectivo += venta.total;
        case MetodoPago.tarjeta:
          tarjeta += venta.total;
        case MetodoPago.transferencia:
          transferencia += venta.total;
        case MetodoPago.credito:
          credito += venta.total;
      }
    }

    double entradas = 0, salidas = 0, gastos = 0;
    for (final mov in movimientos) {
      switch (mov.tipo) {
        case TipoMovimientoCaja.entrada:
        case TipoMovimientoCaja.deposito:
          entradas += mov.monto;
        case TipoMovimientoCaja.salida:
        case TipoMovimientoCaja.retiro:
          salidas += mov.monto;
        case TipoMovimientoCaja.gasto:
          gastos += mov.monto;
      }
    }

    final montoEsperado =
        sesion.montoApertura + efectivo + entradas - salidas - gastos;

    return ResumenCierreCaja(
      montoApertura: sesion.montoApertura,
      totalVentasEfectivo: efectivo,
      totalVentasTarjeta: tarjeta,
      totalVentasTransferencia: transferencia,
      totalVentasCredito: credito,
      totalEntradas: entradas,
      totalSalidas: salidas,
      totalGastos: gastos,
      montoEsperado: montoEsperado,
      cantidadVentas: cantidadVentas,
    );
  }

  Future<SesionCaja> cerrar({
    required SesionCaja sesion,
    required String usuarioCierreId,
    required double montoContado,
    String? notaCierre,
  }) async {
    final resumen = await calcularResumen(sesion);
    final diferencia = montoContado - resumen.montoEsperado;
    final cerrada = sesion.copyWith(
      usuarioCierreId: usuarioCierreId,
      montoEsperado: resumen.montoEsperado,
      montoContado: montoContado,
      diferencia: diferencia,
      estado: EstadoSesionCaja.cerrada,
      cerradaEn: DateTime.now(),
      notaCierre: notaCierre,
    );
    await _sesionDao.update(cerrada);
    return cerrada;
  }

  Future<MovimientoCaja> registrarMovimiento({
    required String sesionCajaId,
    required String tipo,
    required double monto,
    String? categoriaGasto,
    String? descripcion,
    required String usuarioId,
    required String empresaId,
    String? sucursalId,
    String? cajaId,
    String? dispositivoId,
  }) async {
    final now = DateTime.now();
    final movimiento = MovimientoCaja(
      id: IdGenerator.newId(),
      sesionCajaId: sesionCajaId,
      tipo: tipo,
      categoriaGasto: categoriaGasto,
      monto: monto,
      descripcion: descripcion,
      usuarioId: usuarioId,
      ocurridoEn: now,
      empresaId: empresaId,
      sucursalId: sucursalId,
      cajaId: cajaId,
      dispositivoId: dispositivoId,
      creadoEn: now,
      actualizadoEn: now,
    );
    await _movimientoDao.insert(movimiento);
    return movimiento;
  }

  Future<List<MovimientoCaja>> movimientosDe(String sesionCajaId) =>
      _movimientoDao.deSesion(sesionCajaId);

  Future<List<SesionCaja>> historial(String sucursalId) =>
      _sesionDao.historial(sucursalId);
}

final cajaRepositoryProvider = Provider<CajaRepository>((ref) {
  return CajaRepository(
    ref.watch(sesionCajaDaoProvider),
    ref.watch(movimientoCajaDaoProvider),
    ref.watch(ventaDaoProvider),
  );
});
