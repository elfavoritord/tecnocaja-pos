import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/permisos.dart';
import '../../domain/entities/sesion_caja.dart';
import '../../domain/entities/sucursal_caja.dart';
import '../auth/auth_controller.dart';
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
  final sucursales = await ref.watch(empresaRepositoryProvider).sucursalesDe(empresaId);
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
  final caja = await ref.watch(cajaActivaProvider.future);
  if (caja == null) return null;
  return ref.watch(cajaRepositoryProvider).sesionAbiertaDe(caja.id);
});

/// Rol + overrides individuales del usuario logueado. La UI la usa para
/// ocultar/bloquear botones (anular, reimprimir, etc.) en vez de solo
/// deshabilitarlos -- ver Permiso.
final permisosUsuarioActualProvider = FutureProvider<Set<Permiso>>((ref) async {
  final usuario = ref.watch(authControllerProvider).usuario;
  if (usuario == null) return <Permiso>{};
  return ref.watch(usuarioRepositoryProvider).permisosEfectivos(usuario);
});
