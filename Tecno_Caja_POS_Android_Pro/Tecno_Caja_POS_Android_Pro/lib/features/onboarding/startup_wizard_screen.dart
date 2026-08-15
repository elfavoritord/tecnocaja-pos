import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/business/business_capabilities.dart';
import '../../core/constants/dominicana.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/dgii_repository.dart';
import '../../data/sync/vinculacion_repository.dart';
import '../../widgets/app_logo.dart';
import '../../widgets/loading_button.dart';

class StartupWizardScreen extends ConsumerStatefulWidget {
  const StartupWizardScreen({super.key});

  @override
  ConsumerState<StartupWizardScreen> createState() =>
      _StartupWizardScreenState();
}

class _StartupWizardScreenState extends ConsumerState<StartupWizardScreen> {
  static const _totalSteps = 7;

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
  final _montoAperturaCtrl = TextEditingController(text: '0');

  int _step = 0;
  String _modoInstalacion = 'standalone';
  String _estructura = 'monocaja';
  String _tipoNegocio = Dominicana.tiposDeNegocio.first;
  Set<String> _capabilities = BusinessCatalog.recommendedCodes(
    Dominicana.tiposDeNegocio.first,
  );
  String _provincia = Dominicana.provincias.first;
  String _moneda = 'DOP';
  String _impresionModo = 'dialogo';
  int _papelMm = 58;
  String? _logoPath;
  bool _usaComprobantesFiscales = true;
  bool _requiereCajaAbierta = true;
  bool _crearCatalogoBase = true;
  bool _cargando = false;
  bool _consultandoDgii = false;
  String? _dgiiEstado;
  String? _dgiiTipo;
  String? _dgiiCategoria;
  String? _dgiiMessage;
  bool _dgiiFound = false;
  String? _lastDgiiDocument;
  Timer? _dgiiDebounce;

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
    _montoAperturaCtrl.dispose();
    _dgiiDebounce?.cancel();
    super.dispose();
  }

  Future<void> _elegirLogo() async {
    final archivo = await ImagePicker()
        .pickImage(source: ImageSource.gallery, maxWidth: 512, maxHeight: 512);
    if (archivo != null) setState(() => _logoPath = archivo.path);
  }

  Future<void> _crearNegocio() async {
    final validationError = _firstValidationError();
    if (validationError != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(validationError)));
      return;
    }
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
      final montoApertura =
          double.tryParse(_montoAperturaCtrl.text.replaceAll(',', '.')) ?? 0;
      final nombreComercial = _nombreComercialCtrl.text.trim();
      final razonSocial = _razonSocialCtrl.text.trim();
      final rnc = _rncCtrl.text.trim();
      final direccion = _direccionCtrl.text.trim();
      final telefonoNegocio = _telefonoNegocioCtrl.text.trim();
      final businessProfile = BusinessCatalog.byValue(_tipoNegocio);

      final resultado =
          await ref.read(cloudFunctionsServiceProvider).createMobileCompany({
        'ownerNombre': _ownerNombreCtrl.text.trim(),
        'ownerApellido': _ownerApellidoCtrl.text.trim(),
        'email': firebaseUser.email ?? '',
        'telefono': _telefonoPropietarioCtrl.text.trim(),
        'telefonoNegocio': telefonoNegocio,
        'nombreComercial': nombreComercial,
        'razonSocial': razonSocial,
        'rncCedula': rnc,
        'dgiiEstado': _dgiiEstado,
        'dgiiTipoContribuyente': _dgiiTipo,
        'dgiiCategoria': _dgiiCategoria,
        'dgiiConsultadoEn':
            _dgiiFound ? DateTime.now().toIso8601String() : null,
        'direccion': direccion,
        'provincia': _provincia,
        'municipio': _municipioCtrl.text.trim(),
        'tipoNegocio': _tipoNegocio,
        'tipoNegocioCode': businessProfile.code,
        'businessCapabilities': _capabilities.toList()..sort(),
        'monedaPrincipal': _moneda,
        'tasaItbis': itbis,
        'usaComprobantesFiscales': _usaComprobantesFiscales,
        'logoUrl': null,
        'deviceId': deviceId,
        'deviceName': infoDispositivo.nombreParaMostrar,
        'platform': kIsWeb ? 'web' : defaultTargetPlatform.name,
        'mobileSetupWizardVersion': 1,
        'setupMode': _modoInstalacion,
        'businessStructureMode': _estructura,
        'receiptPrintMode': _impresionModo,
        'receiptPaperSizeMm': _papelMm,
        'openingAmount': montoApertura,
        'requireCashOpenBeforeUse': _requiereCajaAbierta,
        'seedStarterCatalog': _crearCatalogoBase,
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

      await ref.read(configuracionControllerProvider.notifier).actualizar(
            (config) => config.copyWith(
              businessType: businessProfile.code,
              businessCapabilities: _capabilities,
              fiscalUsaComprobantes: _usaComprobantesFiscales,
              fiscalModoComprobante: _usaComprobantesFiscales
                  ? 'ncf_tradicional'
                  : 'sin_comprobantes',
              impresoraAnchoMm: _papelMm,
              imprimirAutomatico: _impresionModo == 'automatica',
            ),
          );

      if (!mounted) return;
      ref
          .read(authControllerProvider.notifier)
          .onboardingCompletado(usuarioLocal);
    } on AppException catch (e) {
      debugPrint(
          '[StartupWizardScreen] AppException: ${e.message} (causa: ${e.cause})');
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e, st) {
      debugPrint(
          '[StartupWizardScreen] Error inesperado (${e.runtimeType}): $e\n$st');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('No se pudo configurar el POS movil: $e')),
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

  void _siguiente() {
    final error = _validationErrorForStep(_step);
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    if (_step < _totalSteps - 1) setState(() => _step++);
  }

  void _anterior() {
    if (_step > 0) setState(() => _step--);
  }

  void _seleccionarTipoNegocio(String value) {
    setState(() {
      _tipoNegocio = value;
      _capabilities = BusinessCatalog.recommendedCodes(value);
    });
  }

  void _onBusinessDocumentChanged(String value) {
    _dgiiDebounce?.cancel();
    final document = value.replaceAll(RegExp(r'\D'), '');
    if (document != _lastDgiiDocument) {
      setState(() {
        _dgiiMessage = null;
        _dgiiFound = false;
      });
    }
    if (Validators.cedulaORnc(document) != null) return;
    _dgiiDebounce = Timer(
      const Duration(milliseconds: 700),
      () => _consultarDgiiNegocio(),
    );
  }

  Future<void> _consultarDgiiNegocio({bool force = false}) async {
    final document = _rncCtrl.text.replaceAll(RegExp(r'\D'), '');
    final validationError = Validators.cedulaORnc(document);
    if (validationError != null) {
      setState(() {
        _dgiiMessage = validationError;
        _dgiiFound = false;
      });
      return;
    }
    if (!force && document == _lastDgiiDocument) return;
    setState(() {
      _consultandoDgii = true;
      _dgiiMessage = null;
    });
    try {
      final result = await ref.read(dgiiRepositoryProvider).lookup(document);
      _lastDgiiDocument = document;
      if (!mounted) return;
      if (!result.found) {
        setState(() {
          _dgiiMessage =
              'Documento no encontrado en la consulta DGII. Verifica el número o completa los datos manualmente.';
          _dgiiFound = false;
          _dgiiEstado = null;
          _dgiiTipo = null;
          _dgiiCategoria = null;
        });
        return;
      }
      setState(() {
        if (result.name != null) _razonSocialCtrl.text = result.name!;
        if (result.commercialName != null) {
          _nombreComercialCtrl.text = result.commercialName!;
        } else if (_nombreComercialCtrl.text.trim().isEmpty &&
            result.name != null) {
          _nombreComercialCtrl.text = result.name!;
        }
        if (result.address != null) _direccionCtrl.text = result.address!;
        _dgiiEstado = result.status;
        _dgiiTipo = result.taxpayerType;
        _dgiiCategoria = result.category;
        _dgiiMessage = 'Documento encontrado en DGII.';
        _dgiiFound = true;
      });
    } on ValidationException catch (error) {
      _setDgiiError('Documento inválido: ${error.message}');
    } on NetworkException catch (error) {
      _setDgiiError(error.message);
    } on ServerException catch (_) {
      _setDgiiError(
        'Error interno al consultar DGII. Intenta nuevamente; el documento no se marcó como inválido.',
      );
    } on AppException catch (error) {
      _setDgiiError(error.message);
    } finally {
      if (mounted) setState(() => _consultandoDgii = false);
    }
  }

  void _setDgiiError(String message) {
    if (!mounted) return;
    setState(() {
      _dgiiMessage = message;
      _dgiiFound = false;
    });
  }

  String? _firstValidationError() {
    for (var step = 0; step < _totalSteps - 1; step++) {
      final error = _validationErrorForStep(step);
      if (error != null) return error;
    }
    return null;
  }

  String? _validationErrorForStep(int step) {
    return switch (step) {
      2 => Validators.required(_ownerNombreCtrl.text, label: 'Tu nombre') ??
          Validators.required(_ownerApellidoCtrl.text, label: 'Tu apellido') ??
          Validators.phoneRD(_telefonoPropietarioCtrl.text),
      3 => Validators.required(_nombreComercialCtrl.text,
              label: 'Nombre comercial') ??
          Validators.required(_razonSocialCtrl.text, label: 'Razón social') ??
          Validators.cedulaORnc(_rncCtrl.text) ??
          Validators.required(_direccionCtrl.text, label: 'Dirección') ??
          Validators.required(_municipioCtrl.text, label: 'Municipio') ??
          Validators.phoneRD(_telefonoNegocioCtrl.text, optional: true),
      4 => Validators.positiveNumber(_itbisCtrl.text, label: 'ITBIS'),
      5 => Validators.positiveNumber(
          _montoAperturaCtrl.text,
          label: 'Monto inicial',
        ),
      _ => null,
    };
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final progress = (_step + 1) / _totalSteps;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Asistente de inicio'),
        automaticallyImplyLeading: false,
        actions: [
          TextButton(
            onPressed: _cargando
                ? null
                : () =>
                    ref.read(authControllerProvider.notifier).cerrarSesion(),
            child: const Text('Cerrar sesion'),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: AppLogo(size: 64)),
                    const SizedBox(height: 12),
                    Text(
                      _tituloPaso,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _subtituloPaso,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 18),
                    LinearProgressIndicator(value: progress),
                    const SizedBox(height: 24),
                    _contenidoPaso(),
                    const SizedBox(height: 24),
                    Row(
                      children: [
                        if (_step > 0)
                          Expanded(
                            child: OutlinedButton.icon(
                              onPressed: _cargando ? null : _anterior,
                              icon: const Icon(Icons.arrow_back),
                              label: const Text('Atras'),
                            ),
                          ),
                        if (_step > 0) const SizedBox(width: 12),
                        Expanded(
                          child: _step == _totalSteps - 1
                              ? LoadingButton(
                                  label: 'Crear mi POS movil',
                                  icon: Icons.check_circle_outline,
                                  isLoading: _cargando,
                                  onPressed: _crearNegocio,
                                )
                              : FilledButton.icon(
                                  onPressed: _cargando ? null : _siguiente,
                                  icon: const Icon(Icons.arrow_forward),
                                  label: const Text('Siguiente'),
                                ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String get _tituloPaso {
    return switch (_step) {
      0 => 'Como vas a usar Tecno Caja movil',
      1 => 'Estructura del negocio',
      2 => 'Propietario',
      3 => 'Datos del negocio',
      4 => 'Fiscal y DGII',
      5 => 'Impresion y caja',
      _ => 'Resumen de configuracion',
    };
  }

  String get _subtituloPaso {
    return switch (_step) {
      0 => 'Puedes usarlo independiente o conectado al POS Windows.',
      1 => 'Elige la misma forma de trabajo que tendra el POS principal.',
      2 => 'Estos datos crean el administrador principal.',
      3 => 'Define la sucursal inicial, moneda e impuestos.',
      4 => 'Activa comprobantes desde el inicio si usaras NCF/e-CF.',
      5 => 'Configura la venta diaria antes de entrar al dashboard.',
      _ => 'Revisa todo antes de crear la empresa movil.',
    };
  }

  Widget _contenidoPaso() {
    return switch (_step) {
      0 => _pasoModo(),
      1 => _pasoEstructura(),
      2 => _pasoPropietario(),
      3 => _pasoNegocio(),
      4 => _pasoFiscal(),
      5 => _pasoImpresionCaja(),
      _ => _pasoResumen(),
    };
  }

  Widget _pasoModo() {
    return Column(
      children: [
        _opcionCard(
          selected: _modoInstalacion == 'standalone',
          icon: Icons.phone_android,
          title: 'POS movil independiente',
          subtitle: 'Vende, cobra, maneja inventario y opera offline.',
          onTap: () => setState(() => _modoInstalacion = 'standalone'),
        ),
        const SizedBox(height: 12),
        _opcionCard(
          selected: _modoInstalacion == 'vinculado',
          icon: Icons.sync_alt,
          title: 'Conectar con mi POS Windows',
          subtitle: 'Trae empresa, sucursal, caja y permisos desde la nube.',
          onTap: () => setState(() => _modoInstalacion = 'vinculado'),
        ),
        if (_modoInstalacion == 'vinculado') ...[
          const SizedBox(height: 16),
          LoadingButton(
            label: 'Buscar mi POS en la nube',
            icon: Icons.cloud_download_outlined,
            outlined: true,
            isLoading: _cargando,
            onPressed: _buscarNegocioExistente,
          ),
        ],
      ],
    );
  }

  Widget _pasoEstructura() {
    return Column(
      children: [
        _opcionCard(
          selected: _estructura == 'monocaja',
          icon: Icons.point_of_sale,
          title: 'Monocaja',
          subtitle: 'Un negocio, una sucursal y una caja principal.',
          onTap: () => setState(() => _estructura = 'monocaja'),
        ),
        const SizedBox(height: 12),
        _opcionCard(
          selected: _estructura == 'multicaja',
          icon: Icons.storefront,
          title: 'Multicaja',
          subtitle: 'Varias cajas sincronizadas dentro de la misma sucursal.',
          onTap: () => setState(() => _estructura = 'multicaja'),
        ),
        const SizedBox(height: 12),
        _opcionCard(
          selected: _estructura == 'multisucursal',
          icon: Icons.account_tree_outlined,
          title: 'Multisucursal',
          subtitle: 'Preparado para varias sucursales y terminales moviles.',
          onTap: () => setState(() => _estructura = 'multisucursal'),
        ),
      ],
    );
  }

  Widget _pasoPropietario() {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: TextFormField(
                controller: _ownerNombreCtrl,
                decoration: const InputDecoration(labelText: 'Nombre'),
                validator: (v) => Validators.required(v, label: 'Tu nombre'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextFormField(
                controller: _ownerApellidoCtrl,
                decoration: const InputDecoration(labelText: 'Apellido'),
                validator: (v) => Validators.required(v, label: 'Tu apellido'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _telefonoPropietarioCtrl,
          keyboardType: TextInputType.phone,
          decoration: const InputDecoration(labelText: 'Telefono propietario'),
          validator: Validators.phoneRD,
        ),
      ],
    );
  }

  Widget _pasoNegocio() {
    return Column(
      children: [
        Center(
          child: GestureDetector(
            onTap: _elegirLogo,
            child: CircleAvatar(
              radius: 42,
              child: Icon(
                _logoPath == null
                    ? Icons.add_a_photo_outlined
                    : Icons.check_circle_outline,
              ),
            ),
          ),
        ),
        TextButton(
          onPressed: _elegirLogo,
          child: Text(_logoPath == null ? 'Logo del negocio' : 'Logo elegido'),
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: _nombreComercialCtrl,
          decoration: const InputDecoration(labelText: 'Nombre comercial'),
          validator: (v) => Validators.required(v, label: 'Nombre comercial'),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _razonSocialCtrl,
          decoration: const InputDecoration(labelText: 'Razon social'),
          validator: (v) => Validators.required(v, label: 'Razon social'),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _rncCtrl,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: 'RNC o cédula',
            suffixIcon: _consultandoDgii
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : IconButton(
                    tooltip: 'Consultar DGII',
                    onPressed: () => _consultarDgiiNegocio(force: true),
                    icon: const Icon(Icons.manage_search),
                  ),
          ),
          validator: Validators.cedulaORnc,
          onChanged: _onBusinessDocumentChanged,
        ),
        if (_dgiiMessage != null) ...[
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                _dgiiFound ? Icons.verified_outlined : Icons.info_outline,
                color: _dgiiFound
                    ? Colors.green
                    : Theme.of(context).colorScheme.error,
              ),
              const SizedBox(width: 8),
              Expanded(child: Text(_dgiiMessage!)),
            ],
          ),
        ],
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: _tipoNegocio,
          isExpanded: true,
          menuMaxHeight: 320,
          decoration: const InputDecoration(labelText: 'Tipo de negocio'),
          items: Dominicana.tiposDeNegocio
              .map(
                (tipo) => DropdownMenuItem(
                  value: tipo,
                  child: Text(tipo, overflow: TextOverflow.ellipsis),
                ),
              )
              .toList(),
          onChanged: (v) {
            if (v != null) _seleccionarTipoNegocio(v);
          },
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: Text(
            '${_capabilities.length} capacidades recomendadas activas',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _direccionCtrl,
          decoration: const InputDecoration(labelText: 'Direccion'),
          validator: (value) => Validators.required(value, label: 'Dirección'),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _provincia,
                decoration: const InputDecoration(labelText: 'Provincia'),
                items: Dominicana.provincias
                    .map((p) => DropdownMenuItem(value: p, child: Text(p)))
                    .toList(),
                onChanged: (v) => setState(() => _provincia = v ?? _provincia),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextFormField(
                controller: _municipioCtrl,
                decoration: const InputDecoration(labelText: 'Municipio'),
                validator: (value) =>
                    Validators.required(value, label: 'Municipio'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextFormField(
                controller: _telefonoNegocioCtrl,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Telefono'),
                validator: (value) => Validators.phoneRD(value, optional: true),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _moneda,
                decoration: const InputDecoration(labelText: 'Moneda'),
                items: Dominicana.monedas
                    .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                    .toList(),
                onChanged: (v) => setState(() => _moneda = v ?? _moneda),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _pasoFiscal() {
    return Column(
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _usaComprobantesFiscales,
          title: const Text('Usar comprobantes fiscales'),
          subtitle:
              const Text('Activa NCF/e-CF, reportes DGII y datos fiscales.'),
          onChanged: (v) => setState(() => _usaComprobantesFiscales = v),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _itbisCtrl,
          enabled: _usaComprobantesFiscales,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            labelText: 'ITBIS por defecto',
            suffixText: '%',
          ),
          validator: (v) => Validators.positiveNumber(v, label: 'ITBIS'),
        ),
        const SizedBox(height: 12),
        _infoBox(
          icon: Icons.verified_user_outlined,
          text:
              'La certificacion DGII y la firma e-CF completa se hacen desde el modulo fiscal seguro conectado al POS/servidor.',
        ),
      ],
    );
  }

  Widget _pasoImpresionCaja() {
    return Column(
      children: [
        SegmentedButton<int>(
          segments: const [
            ButtonSegment(value: 58, label: Text('58 mm')),
            ButtonSegment(value: 80, label: Text('80 mm')),
          ],
          selected: {_papelMm},
          onSelectionChanged: (v) => setState(() => _papelMm = v.first),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: _impresionModo,
          decoration: const InputDecoration(labelText: 'Modo de impresion'),
          items: const [
            DropdownMenuItem(
                value: 'dialogo', child: Text('Preguntar al vender')),
            DropdownMenuItem(
                value: 'automatica', child: Text('Imprimir automatico')),
            DropdownMenuItem(value: 'manual', child: Text('Solo manual')),
          ],
          onChanged: (v) =>
              setState(() => _impresionModo = v ?? _impresionModo),
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _montoAperturaCtrl,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Monto inicial de caja'),
          validator: (v) =>
              Validators.positiveNumber(v, label: 'Monto inicial'),
        ),
        const SizedBox(height: 12),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _requiereCajaAbierta,
          title: const Text('Exigir caja abierta para vender'),
          onChanged: (v) => setState(() => _requiereCajaAbierta = v),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _crearCatalogoBase,
          title: const Text('Crear catalogo inicial sugerido'),
          subtitle: const Text('Categorias y productos base segun el negocio.'),
          onChanged: (v) => setState(() => _crearCatalogoBase = v),
        ),
      ],
    );
  }

  Widget _pasoResumen() {
    return Column(
      children: [
        _resumenTile(
            'Modo',
            _modoInstalacion == 'standalone'
                ? 'Independiente'
                : 'Vinculado al POS Windows'),
        _resumenTile('Estructura', _estructura),
        _resumenTile(
            'Negocio',
            _nombreComercialCtrl.text.trim().isEmpty
                ? 'Pendiente'
                : _nombreComercialCtrl.text.trim()),
        _resumenTile('Tipo', _tipoNegocio),
        _resumenTile(
            'Fiscal', _usaComprobantesFiscales ? 'Activo' : 'Inactivo'),
        _resumenTile('Impresion', '$_papelMm mm / $_impresionModo'),
        _resumenTile('Caja inicial', _montoAperturaCtrl.text.trim()),
      ],
    );
  }

  Widget _opcionCard({
    required bool selected,
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    final color = Theme.of(context).colorScheme.primary;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: selected ? color : Colors.grey.shade300),
          color: selected ? color.withValues(alpha: .08) : null,
        ),
        child: Row(
          children: [
            Icon(icon, color: selected ? color : null),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text(subtitle),
                ],
              ),
            ),
            if (selected) Icon(Icons.check_circle, color: color),
          ],
        ),
      ),
    );
  }

  Widget _infoBox({required IconData icon, required String text}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
      child: Row(
        children: [
          Icon(icon),
          const SizedBox(width: 10),
          Expanded(child: Text(text)),
        ],
      ),
    );
  }

  Widget _resumenTile(String label, String value) {
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      title: Text(label),
      trailing: Text(
        value,
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
    );
  }
}
