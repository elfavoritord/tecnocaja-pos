import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/constants/dominicana.dart';
import '../../core/constants/roles.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/usuario_repository.dart';
import '../../widgets/app_logo.dart';
import '../../widgets/loading_button.dart';

/// Alta del negocio (empresa + sucursal + caja principal + usuario
/// administrador) para la cuenta de Firebase recien autenticada. Se muestra
/// una sola vez por instalacion -- si Emilio quiere convertir esto en un
/// wizard multi-paso mas adelante, la logica de creacion (al final del
/// archivo) no cambia, solo la presentacion.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nombreNegocioCtrl = TextEditingController();
  final _nombreComercialCtrl = TextEditingController();
  final _rncCtrl = TextEditingController();
  final _direccionCtrl = TextEditingController();
  final _telefonoCtrl = TextEditingController();
  final _itbisCtrl = TextEditingController(text: '18');

  String _tipoNegocio = Dominicana.tiposDeNegocio.first;
  String _provincia = Dominicana.provincias.first;
  String _moneda = 'DOP';
  String? _logoPath;
  bool _cargando = false;

  @override
  void dispose() {
    _nombreNegocioCtrl.dispose();
    _nombreComercialCtrl.dispose();
    _rncCtrl.dispose();
    _direccionCtrl.dispose();
    _telefonoCtrl.dispose();
    _itbisCtrl.dispose();
    super.dispose();
  }

  Future<void> _elegirLogo() async {
    final archivo = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 512, maxHeight: 512);
    if (archivo != null) setState(() => _logoPath = archivo.path);
  }

  Future<void> _crearNegocio() async {
    if (!_formKey.currentState!.validate()) return;
    final firebaseUser = FirebaseAuth.instance.currentUser;
    if (firebaseUser == null) return;

    setState(() => _cargando = true);
    try {
      final deviceId = await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final empresaRepo = ref.read(empresaRepositoryProvider);
      final usuarioRepo = ref.read(usuarioRepositoryProvider);
      final configRepo = ref.read(configuracionRepositoryProvider);
      final itbis = (double.tryParse(_itbisCtrl.text.replaceAll(',', '.')) ?? 18) / 100;

      final empresa = await empresaRepo.crear(
        nombre: _nombreNegocioCtrl.text.trim(),
        nombreComercial: _nombreComercialCtrl.text.trim().isEmpty ? null : _nombreComercialCtrl.text.trim(),
        rncCedula: _rncCtrl.text.trim().isEmpty ? null : _rncCtrl.text.trim(),
        direccion: _direccionCtrl.text.trim().isEmpty ? null : _direccionCtrl.text.trim(),
        telefono: _telefonoCtrl.text.trim().isEmpty ? null : _telefonoCtrl.text.trim(),
        email: firebaseUser.email,
        tipoNegocio: _tipoNegocio,
        provincia: _provincia,
        monedaPrincipal: _moneda,
        tasaItbisDefault: itbis,
        dispositivoId: deviceId,
      );

      final sucursal = await empresaRepo.crearSucursal(
        empresaId: empresa.id,
        nombre: 'Principal',
        codigo: 'S01',
        direccion: empresa.direccion,
        telefono: empresa.telefono,
        dispositivoId: deviceId,
      );

      await empresaRepo.crearCaja(
        empresaId: empresa.id,
        sucursalId: sucursal.id,
        nombre: 'Caja 1',
        codigo: 'C01',
        dispositivoId: deviceId,
      );

      final usuarioLocal = await usuarioRepo.crear(
        empresaId: empresa.id,
        sucursalId: sucursal.id,
        nombre: firebaseUser.displayName?.trim().isNotEmpty == true ? firebaseUser.displayName!.trim() : 'Administrador',
        usuario: (firebaseUser.email ?? 'admin').split('@').first,
        email: firebaseUser.email,
        telefono: _telefonoCtrl.text.trim().isEmpty ? null : _telefonoCtrl.text.trim(),
        rol: RolBase.administradorGeneral,
        firebaseUid: firebaseUser.uid,
        dispositivoId: deviceId,
      );

      final configuracionActual = await configRepo.obtener();
      await configRepo.guardar(configuracionActual.copyWith(empresaId: empresa.id, itbisDefault: itbis));

      if (!mounted) return;
      ref.read(authControllerProvider.notifier).onboardingCompletado(usuarioLocal);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('No se pudo crear el negocio: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Configura tu negocio'),
        automaticallyImplyLeading: false,
        actions: [
          TextButton(
            onPressed: () => ref.read(authControllerProvider.notifier).cerrarSesion(),
            child: const Text('Cerrar sesión'),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: AppLogo(size: 64)),
                    const SizedBox(height: 12),
                    Text(
                      'Un último paso antes de vender',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 20),
                    Center(
                      child: GestureDetector(
                        onTap: _elegirLogo,
                        child: CircleAvatar(
                          radius: 40,
                          backgroundImage: _logoPath != null ? FileImage(File(_logoPath!)) : null,
                          child: _logoPath == null ? const Icon(Icons.add_a_photo_outlined) : null,
                        ),
                      ),
                    ),
                    Center(
                      child: TextButton(onPressed: _elegirLogo, child: const Text('Logo del negocio (opcional)')),
                    ),
                    const SizedBox(height: 8),
                    TextFormField(
                      controller: _nombreNegocioCtrl,
                      decoration: const InputDecoration(labelText: 'Nombre del negocio'),
                      validator: (v) => Validators.required(v, label: 'El nombre del negocio'),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _nombreComercialCtrl,
                      decoration: const InputDecoration(labelText: 'Nombre comercial (opcional)'),
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<String>(
                      initialValue: _tipoNegocio,
                      decoration: const InputDecoration(labelText: 'Tipo de negocio'),
                      items: Dominicana.tiposDeNegocio.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                      onChanged: (v) => setState(() => _tipoNegocio = v ?? _tipoNegocio),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _rncCtrl,
                      decoration: const InputDecoration(labelText: 'RNC o cédula (opcional)'),
                      validator: (v) => Validators.cedulaORnc(v, optional: true),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _direccionCtrl,
                      decoration: const InputDecoration(labelText: 'Dirección'),
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<String>(
                      initialValue: _provincia,
                      decoration: const InputDecoration(labelText: 'Provincia'),
                      items: Dominicana.provincias.map((p) => DropdownMenuItem(value: p, child: Text(p))).toList(),
                      onChanged: (v) => setState(() => _provincia = v ?? _provincia),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _telefonoCtrl,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(labelText: 'Teléfono del negocio'),
                      validator: (v) => Validators.phoneRD(v, optional: true),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _moneda,
                            decoration: const InputDecoration(labelText: 'Moneda principal'),
                            items: Dominicana.monedas.map((m) => DropdownMenuItem(value: m, child: Text(m))).toList(),
                            onChanged: (v) => setState(() => _moneda = v ?? _moneda),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            controller: _itbisCtrl,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            decoration: const InputDecoration(labelText: 'ITBIS %'),
                            validator: (v) => Validators.positiveNumber(v, label: 'El ITBIS'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),
                    LoadingButton(label: 'Crear mi negocio', isLoading: _cargando, onPressed: _crearNegocio),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
