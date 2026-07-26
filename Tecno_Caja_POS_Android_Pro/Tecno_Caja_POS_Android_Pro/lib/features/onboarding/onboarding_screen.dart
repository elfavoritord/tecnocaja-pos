import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/constants/dominicana.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/sync/vinculacion_repository.dart';
import '../../widgets/app_logo.dart';
import '../../widgets/loading_button.dart';

/// Alta de una empresa 100% móvil -- NUNCA depende de Tecno Caja POS
/// Windows. Se muestra una sola vez por instalación (cuando Firebase ya
/// autenticó a alguien pero todavía no tiene un [Usuario] local ni logró
/// vincularse a un POS existente -- ver AuthController). La creación real
/// ocurre en la nube (Cloud Function `createMobileCompany`, único lugar que
/// decide el `businessId`); esta pantalla solo junta los datos y después
/// espeja el resultado en la base local (`VinculacionRepository.
/// vincularDesdeNube`) para que la app siga funcionando offline.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  final _formKey = GlobalKey<FormState>();
  final _ownerNombreCtrl = TextEditingController();
  final _ownerApellidoCtrl = TextEditingController();
  final _telefonoPropietarioCtrl = TextEditingController();
  final _nombreComercialCtrl = TextEditingController();
  final _razonSocialCtrl = TextEditingController();
  final _rncCtrl = TextEditingController();
  final _direccionCtrl = TextEditingController();
  final _municipioCtrl = TextEditingController();
  final _telefonoNegocioCtrl = TextEditingController();
  final _itbisCtrl = TextEditingController(text: '18');

  String _tipoNegocio = Dominicana.tiposDeNegocio.first;
  String _provincia = Dominicana.provincias.first;
  String _moneda = 'DOP';
  String? _logoPath;
  bool _usaComprobantesFiscales = true;
  bool _cargando = false;

  @override
  void dispose() {
    _ownerNombreCtrl.dispose();
    _ownerApellidoCtrl.dispose();
    _telefonoPropietarioCtrl.dispose();
    _nombreComercialCtrl.dispose();
    _razonSocialCtrl.dispose();
    _rncCtrl.dispose();
    _direccionCtrl.dispose();
    _municipioCtrl.dispose();
    _telefonoNegocioCtrl.dispose();
    _itbisCtrl.dispose();
    super.dispose();
  }

  Future<void> _elegirLogo() async {
    final archivo = await ImagePicker()
        .pickImage(source: ImageSource.gallery, maxWidth: 512, maxHeight: 512);
    if (archivo != null) setState(() => _logoPath = archivo.path);
  }

  Future<void> _crearNegocio() async {
    if (!_formKey.currentState!.validate()) return;
    final firebaseUser = FirebaseAuth.instance.currentUser;
    if (firebaseUser == null) return;

    setState(() => _cargando = true);
    try {
      final deviceId =
          await ref.read(secureSessionServiceProvider).obtenerOCrearDeviceId();
      final infoDispositivo =
          await ref.read(deviceInfoServiceProvider).obtener();
      final itbis =
          (double.tryParse(_itbisCtrl.text.replaceAll(',', '.')) ?? 18) / 100;
      final nombreComercial = _nombreComercialCtrl.text.trim();
      final razonSocial = _razonSocialCtrl.text.trim();
      final rnc = _rncCtrl.text.trim();
      final direccion = _direccionCtrl.text.trim();
      final telefonoNegocio = _telefonoNegocioCtrl.text.trim();

      final resultado =
          await ref.read(cloudFunctionsServiceProvider).createMobileCompany({
        'ownerNombre': _ownerNombreCtrl.text.trim(),
        'ownerApellido': _ownerApellidoCtrl.text.trim(),
        'email': firebaseUser.email ?? '',
        'telefono': _telefonoPropietarioCtrl.text.trim(),
        'nombreComercial': nombreComercial,
        'razonSocial': razonSocial,
        'rncCedula': rnc,
        'direccion': direccion,
        'provincia': _provincia,
        'municipio': _municipioCtrl.text.trim(),
        'tipoNegocio': _tipoNegocio,
        'monedaPrincipal': _moneda,
        'tasaItbis': itbis,
        'usaComprobantesFiscales': _usaComprobantesFiscales,
        'logoUrl': null,
        'deviceId': deviceId,
        'deviceName': infoDispositivo.nombreParaMostrar,
        'platform': 'android',
      });

      final usuarioLocal =
          await ref.read(vinculacionRepositoryProvider).vincularDesdeNube(
                businessId: resultado['businessId'] as String,
                branchId: resultado['branchId'] as String,
                registerId: resultado['registerId'] as String,
                nombreComercial: nombreComercial,
                razonSocial: razonSocial,
                rncCedula: rnc.isEmpty ? null : rnc,
                direccion: direccion.isEmpty ? null : direccion,
                telefono: telefonoNegocio.isEmpty ? null : telefonoNegocio,
                provincia: _provincia,
                tipoNegocio: _tipoNegocio,
                monedaPrincipal: _moneda,
                tasaItbis: itbis,
                ownerNombre: _ownerNombreCtrl.text.trim(),
                ownerApellido: _ownerApellidoCtrl.text.trim(),
                email: firebaseUser.email,
                firebaseUid: firebaseUser.uid,
                deviceId: deviceId,
                deviceName: infoDispositivo.nombreParaMostrar,
              );

      if (!mounted) return;
      ref
          .read(authControllerProvider.notifier)
          .onboardingCompletado(usuarioLocal);
    } on AppException catch (e) {
      debugPrint(
          '[OnboardingScreen] AppException: ${e.message} (causa: ${e.cause})');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e, st) {
      debugPrint(
          '[OnboardingScreen] Error inesperado (${e.runtimeType}): $e\n$st');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('No se pudo crear el negocio: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  Future<void> _buscarNegocioExistente() async {
    setState(() => _cargando = true);
    try {
      final encontrado = await ref
          .read(authControllerProvider.notifier)
          .buscarEmpresaExistenteEnNube();
      if (!encontrado && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'No encontramos una empresa vinculada a este correo. Verifica el correo configurado en Usuarios del POS.',
            ),
          ),
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
            onPressed: () =>
                ref.read(authControllerProvider.notifier).cerrarSesion(),
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
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: _cargando ? null : _buscarNegocioExistente,
                      icon: const Icon(Icons.cloud_download_outlined),
                      label: const Text('Cargar los datos de mi POS'),
                    ),
                    const SizedBox(height: 20),
                    Center(
                      child: GestureDetector(
                        onTap: _elegirLogo,
                        child: CircleAvatar(
                          radius: 40,
                          backgroundImage: _logoPath != null
                              ? FileImage(File(_logoPath!))
                              : null,
                          child: _logoPath == null
                              ? const Icon(Icons.add_a_photo_outlined)
                              : null,
                        ),
                      ),
                    ),
                    Center(
                      child: TextButton(
                          onPressed: _elegirLogo,
                          child: const Text('Logo del negocio (opcional)')),
                    ),
                    const SizedBox(height: 8),
                    Text('Propietario',
                        style: Theme.of(context).textTheme.titleSmall),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: _ownerNombreCtrl,
                            decoration:
                                const InputDecoration(labelText: 'Nombre'),
                            validator: (v) =>
                                Validators.required(v, label: 'Tu nombre'),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            controller: _ownerApellidoCtrl,
                            decoration:
                                const InputDecoration(labelText: 'Apellido'),
                            validator: (v) =>
                                Validators.required(v, label: 'Tu apellido'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _telefonoPropietarioCtrl,
                      keyboardType: TextInputType.phone,
                      decoration:
                          const InputDecoration(labelText: 'Tu teléfono'),
                      validator: (v) => Validators.phoneRD(v, optional: false),
                    ),
                    const SizedBox(height: 20),
                    Text('Negocio',
                        style: Theme.of(context).textTheme.titleSmall),
                    const SizedBox(height: 8),
                    TextFormField(
                      controller: _nombreComercialCtrl,
                      decoration:
                          const InputDecoration(labelText: 'Nombre comercial'),
                      validator: (v) =>
                          Validators.required(v, label: 'El nombre comercial'),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _razonSocialCtrl,
                      decoration:
                          const InputDecoration(labelText: 'Razón social'),
                      validator: (v) =>
                          Validators.required(v, label: 'La razón social'),
                    ),
                    const SizedBox(height: 14),
                    DropdownButtonFormField<String>(
                      initialValue: _tipoNegocio,
                      isExpanded: true,
                      decoration:
                          const InputDecoration(labelText: 'Tipo de negocio'),
                      items: Dominicana.tiposDeNegocio
                          .map(
                              (t) => DropdownMenuItem(value: t, child: Text(t)))
                          .toList(),
                      onChanged: (v) =>
                          setState(() => _tipoNegocio = v ?? _tipoNegocio),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _rncCtrl,
                      decoration:
                          const InputDecoration(labelText: 'RNC o cédula'),
                      validator: (v) => Validators.cedulaORnc(v,
                          optional: !_usaComprobantesFiscales),
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _direccionCtrl,
                      decoration: const InputDecoration(labelText: 'Dirección'),
                      validator: (v) =>
                          Validators.required(v, label: 'La dirección'),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _provincia,
                            isExpanded: true,
                            decoration:
                                const InputDecoration(labelText: 'Provincia'),
                            items: Dominicana.provincias
                                .map((p) =>
                                    DropdownMenuItem(value: p, child: Text(p)))
                                .toList(),
                            onChanged: (v) =>
                                setState(() => _provincia = v ?? _provincia),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            controller: _municipioCtrl,
                            decoration:
                                const InputDecoration(labelText: 'Municipio'),
                            validator: (v) =>
                                Validators.required(v, label: 'El municipio'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _telefonoNegocioCtrl,
                      keyboardType: TextInputType.phone,
                      decoration: const InputDecoration(
                          labelText: 'Teléfono del negocio'),
                      validator: (v) => Validators.phoneRD(v, optional: true),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _moneda,
                            isExpanded: true,
                            decoration: const InputDecoration(
                                labelText: 'Moneda principal'),
                            items: Dominicana.monedas
                                .map((m) =>
                                    DropdownMenuItem(value: m, child: Text(m)))
                                .toList(),
                            onChanged: (v) =>
                                setState(() => _moneda = v ?? _moneda),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: TextFormField(
                            controller: _itbisCtrl,
                            keyboardType: const TextInputType.numberWithOptions(
                                decimal: true),
                            decoration:
                                const InputDecoration(labelText: 'ITBIS %'),
                            validator: (v) =>
                                Validators.positiveNumber(v, label: 'El ITBIS'),
                          ),
                        ),
                      ],
                    ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _usaComprobantesFiscales,
                      title: const Text('Usar comprobantes fiscales (NCF)'),
                      subtitle: const Text(
                          'Se puede activar la facturación electrónica (e-CF) más adelante en Configuración fiscal.'),
                      onChanged: (v) =>
                          setState(() => _usaComprobantesFiscales = v),
                    ),
                    const SizedBox(height: 12),
                    LoadingButton(
                        label: 'Crear mi negocio',
                        isLoading: _cargando,
                        onPressed: _crearNegocio),
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
