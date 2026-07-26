import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/permisos.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/sucursal_caja.dart';
import '../auth/auth_controller.dart';
import '../cloud/cloud_functions_service.dart';
import '../repositories/caja_repository.dart';
import '../repositories/empresa_repository.dart';
import '../repositories/usuario_repository.dart';

/// Sucursal activa de la sesion actual. V1: siempre la primera sucursal de
/// la empresa (onboarding solo crea una) -- cuando exista cambio de sucursal
/// real (Fase de usuarios/multisucursal), esto pasa a leer la preferencia
/// guardada del usuario en vez de "la primera".
final sucursalActivaProvider = FutureProvider<Sucursal?>((ref) async {
  final empresaId = ref.watch(authControllerProvider).empresaId;
  if (empresaId == null) return null;
  final sucursales =
      await ref.watch(empresaRepositoryProvider).sucursalesDe(empresaId);
  return sucursales.isEmpty ? null : sucursales.first;
});

final cajaActivaProvider = FutureProvider<Caja?>((ref) async {
  final sucursal = await ref.watch(sucursalActivaProvider.future);
  if (sucursal == null) return null;
  final cajas = await ref.watch(empresaRepositoryProvider).cajasDe(sucursal.id);
  return cajas.isEmpty ? null : cajas.first;
});

/// null = la caja esta cerrada ahora mismo.
final sesionCajaActivaProvider = FutureProvider<SesionCaja?>((ref) async {
  final auth = ref.watch(authControllerProvider);
  final caja = await ref.watch(cajaActivaProvider.future);
  if (caja == null) return null;
  final repository = ref.watch(cajaRepositoryProvider);
  var sesion = await repository.sesionAbiertaDe(caja.id);
  // Una sesión local de otro usuario no debe restaurarse como si perteneciera
  // a quien acaba de iniciar sesión. El bloqueo central decidirá si esa caja
  // sigue ocupada, mientras cada usuario ve únicamente su propio turno.
  if (sesion != null &&
      auth.usuario != null &&
      sesion.usuarioAperturaId != auth.usuario!.id) {
    sesion = null;
  }
  // Después de vincular/sincronizar con Windows, una caja local puede recibir
  // otro ID aunque el turno abierto siga perteneciendo al mismo usuario. En
  // ese caso se recupera el turno por usuario + empresa, nunca de otra cuenta.
  if (sesion == null && auth.usuario != null && auth.empresaId != null) {
    sesion = await repository.sesionAbiertaDeUsuario(
      auth.usuario!.id,
      empresaId: auth.empresaId,
    );
  }
  if (sesion == null && auth.usuario != null && auth.empresaId != null) {
    try {
      final cloud =
          await ref.read(cloudFunctionsServiceProvider).getMyOpenCashRegister();
      final registerId = cloud['registerId']?.toString();
      final currentRegisterId = caja.remotoId ?? caja.id;
      if (cloud['open'] == true && registerId == currentRegisterId) {
        final deviceId = await ref
            .read(secureSessionServiceProvider)
            .obtenerOCrearDeviceId();
        final openingAmount = (cloud['openingAmount'] as num?)?.toDouble() ?? 0;
        // Reafirma la reserva para este navegador/dispositivo. El backend
        // permite retomar únicamente al mismo usuario que abrió el turno.
        await ref.read(cloudFunctionsServiceProvider).acquireCashRegister(
              registerId: currentRegisterId,
              deviceId: deviceId,
              openingAmount: openingAmount,
            );
        final openedAt =
            DateTime.tryParse(cloud['openedAt']?.toString() ?? '') ??
                DateTime.now();
        sesion = await repository.recuperarTurnoNube(
          empresaId: auth.empresaId!,
          sucursalId: caja.sucursalId,
          cajaId: caja.id,
          usuarioId: auth.usuario!.id,
          montoApertura: openingAmount,
          abiertaEn: openedAt,
          dispositivoId: deviceId,
        );
      }
    } on AppException {
      // Sin Internet se conserva el comportamiento offline. Si no existe una
      // copia local todavía, la pantalla queda cerrada hasta recuperar red.
    }
  }
  if (sesion != null) {
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      await ref.read(cloudFunctionsServiceProvider).acquireCashRegister(
            registerId: caja.remotoId ?? caja.id,
            deviceId: deviceId,
            openingAmount: sesion.montoApertura,
          );
    } on AppException {
      // Un turno ya abierto puede continuar trabajando sin Internet. La
      // reserva se reafirma automáticamente cuando sea posible. La apertura
      // de un turno NUEVO sí exige adquirir el bloqueo central.
    }
  }
  return sesion;
});

/// Rol + overrides individuales del usuario logueado. La UI la usa para
/// ocultar/bloquear botones (anular, reimprimir, etc.) en vez de solo
/// deshabilitarlos -- ver Permiso.
final permisosUsuarioActualProvider = FutureProvider<Set<Permiso>>((ref) async {
  final usuario = ref.watch(authControllerProvider).usuario;
  if (usuario == null) return <Permiso>{};
  return ref.watch(usuarioRepositoryProvider).permisosEfectivos(usuario);
});
