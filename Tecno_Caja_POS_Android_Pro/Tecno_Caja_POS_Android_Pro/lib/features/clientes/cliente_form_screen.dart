import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../core/utils/validators.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/repositories/cliente_repository.dart';
import '../../data/repositories/dgii_repository.dart';
import '../../domain/entities/cliente.dart';
import '../../widgets/loading_button.dart';

class ClienteFormScreen extends ConsumerStatefulWidget {
  const ClienteFormScreen({super.key, this.cliente});

  final Cliente? cliente;

  @override
  ConsumerState<ClienteFormScreen> createState() => _ClienteFormScreenState();
}

class _ClienteFormScreenState extends ConsumerState<ClienteFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final _nombreCtrl = TextEditingController(text: widget.cliente?.nombre);
  late final _nombreComercialCtrl =
      TextEditingController(text: widget.cliente?.nombreComercial);
  late final _telefonoCtrl =
      TextEditingController(text: widget.cliente?.telefono);
  late final _whatsappCtrl =
      TextEditingController(text: widget.cliente?.whatsapp);
  late final _emailCtrl = TextEditingController(text: widget.cliente?.email);
  late final _direccionCtrl =
      TextEditingController(text: widget.cliente?.direccion);
  late final _cedulaRncCtrl =
      TextEditingController(text: widget.cliente?.cedulaRnc);
  late final _limiteCreditoCtrl = TextEditingController(
      text: widget.cliente?.limiteCredito.toStringAsFixed(2) ?? '0');
  late final _notasCtrl = TextEditingController(text: widget.cliente?.notas);
  bool _cargando = false;
  bool _consultandoDgii = false;
  String? _estadoDgii;
  String? _tipoContribuyente;
  String? _categoriaDgii;
  DateTime? _dgiiConsultadoEn;
  String? _mensajeConsulta;
  bool _consultaExitosa = false;
  Timer? _documentDebounce;
  String? _ultimoDocumentoConsultado;

  bool get _esNuevo => widget.cliente == null;

  @override
  void initState() {
    super.initState();
    _estadoDgii = widget.cliente?.estadoDgii;
    _tipoContribuyente = widget.cliente?.tipoContribuyente;
    _categoriaDgii = widget.cliente?.categoriaDgii;
    _dgiiConsultadoEn = widget.cliente?.dgiiConsultadoEn;
  }

  @override
  void dispose() {
    _nombreCtrl.dispose();
    _nombreComercialCtrl.dispose();
    _telefonoCtrl.dispose();
    _whatsappCtrl.dispose();
    _emailCtrl.dispose();
    _direccionCtrl.dispose();
    _cedulaRncCtrl.dispose();
    _limiteCreditoCtrl.dispose();
    _notasCtrl.dispose();
    _documentDebounce?.cancel();
    super.dispose();
  }

  Future<void> _guardar() async {
    if (!_formKey.currentState!.validate()) return;
    final empresaId = ref.read(authControllerProvider).empresaId;
    if (empresaId == null) return;

    setState(() => _cargando = true);
    try {
      final repo = ref.read(clienteRepositoryProvider);
      final limiteCredito =
          double.tryParse(_limiteCreditoCtrl.text.replaceAll(',', '.')) ?? 0;

      if (_esNuevo) {
        final deviceId = await ref
            .read(secureSessionServiceProvider)
            .obtenerOCrearDeviceId();
        await repo.crear(
          empresaId: empresaId,
          nombre: _nombreCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim().isEmpty
              ? null
              : _telefonoCtrl.text.trim(),
          whatsapp: _whatsappCtrl.text.trim().isEmpty
              ? null
              : _whatsappCtrl.text.trim(),
          email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim().isEmpty
              ? null
              : _direccionCtrl.text.trim(),
          cedulaRnc: _cedulaRncCtrl.text.trim().isEmpty
              ? null
              : _cedulaRncCtrl.text.trim(),
          nombreComercial: _emptyToNull(_nombreComercialCtrl.text),
          estadoDgii: _estadoDgii,
          tipoContribuyente: _tipoContribuyente,
          categoriaDgii: _categoriaDgii,
          dgiiConsultadoEn: _dgiiConsultadoEn,
          limiteCredito: limiteCredito,
          notas: _notasCtrl.text.trim().isEmpty ? null : _notasCtrl.text.trim(),
          dispositivoId: deviceId,
        );
      } else {
        final actualizado = widget.cliente!.copyWith(
          nombre: _nombreCtrl.text.trim(),
          telefono: _telefonoCtrl.text.trim(),
          whatsapp: _whatsappCtrl.text.trim(),
          email: _emailCtrl.text.trim(),
          direccion: _direccionCtrl.text.trim(),
          cedulaRnc: _cedulaRncCtrl.text.trim(),
          nombreComercial: _nombreComercialCtrl.text.trim(),
          estadoDgii: _estadoDgii,
          tipoContribuyente: _tipoContribuyente,
          categoriaDgii: _categoriaDgii,
          dgiiConsultadoEn: _dgiiConsultadoEn,
          limiteCredito: limiteCredito,
          notas: _notasCtrl.text.trim(),
        );
        await repo.actualizar(actualizado);
      }

      if (mounted) Navigator.of(context).pop(true);
    } on AppException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (mounted) setState(() => _cargando = false);
    }
  }

  void _onDocumentChanged(String value) {
    _documentDebounce?.cancel();
    final document = ClienteRepository.normalizarDocumento(value);
    if (document != _ultimoDocumentoConsultado) {
      setState(() {
        _mensajeConsulta = null;
        _consultaExitosa = false;
      });
    }
    if (document.isEmpty || Validators.cedulaORnc(document) != null) return;
    _documentDebounce = Timer(
      const Duration(milliseconds: 700),
      () => _consultarDgii(),
    );
  }

  Future<void> _consultarDgii({bool force = false}) async {
    final document = ClienteRepository.normalizarDocumento(_cedulaRncCtrl.text);
    final validationError = Validators.cedulaORnc(document);
    if (validationError != null) {
      setState(() {
        _mensajeConsulta = validationError;
        _consultaExitosa = false;
      });
      return;
    }
    if (!force && document == _ultimoDocumentoConsultado) return;
    final businessId = ref.read(authControllerProvider).empresaId;
    if (businessId == null) return;

    setState(() {
      _consultandoDgii = true;
      _mensajeConsulta = null;
    });
    try {
      final existing = await ref
          .read(clienteRepositoryProvider)
          .porDocumento(businessId, document);
      if (existing != null && existing.id != widget.cliente?.id) {
        throw ConflictException(
          message:
              'Ya existe el cliente ${existing.nombre} con esta cédula/RNC.',
        );
      }

      final result = await ref.read(dgiiRepositoryProvider).lookup(document);
      _ultimoDocumentoConsultado = document;
      if (!result.found) {
        if (!mounted) return;
        setState(() {
          _mensajeConsulta =
              'Documento no encontrado en la consulta DGII. Puedes completar el cliente manualmente.';
          _consultaExitosa = false;
          _estadoDgii = null;
          _tipoContribuyente = null;
          _categoriaDgii = null;
          _dgiiConsultadoEn = null;
        });
        return;
      }

      if (!mounted) return;
      setState(() {
        if (result.name != null) _nombreCtrl.text = result.name!;
        if (result.commercialName != null) {
          _nombreComercialCtrl.text = result.commercialName!;
        }
        if (result.address != null) _direccionCtrl.text = result.address!;
        _estadoDgii = result.status;
        _tipoContribuyente = result.taxpayerType;
        _categoriaDgii = result.category;
        _dgiiConsultadoEn = DateTime.now();
        _mensajeConsulta = 'Documento encontrado en DGII.';
        _consultaExitosa = true;
      });
    } on ValidationException catch (error) {
      _setLookupError('Documento inválido: ${error.message}');
    } on ConflictException catch (error) {
      _setLookupError(error.message);
    } on NetworkException catch (error) {
      _setLookupError(error.message);
    } on ServerException catch (_) {
      _setLookupError(
        'Error interno al consultar DGII. Intenta nuevamente; el documento no se marcó como inválido.',
      );
    } on AppException catch (error) {
      _setLookupError(error.message);
    } finally {
      if (mounted) setState(() => _consultandoDgii = false);
    }
  }

  void _setLookupError(String message) {
    if (!mounted) return;
    setState(() {
      _mensajeConsulta = message;
      _consultaExitosa = false;
    });
  }

  static String? _emptyToNull(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar:
          AppBar(title: Text(_esNuevo ? 'Nuevo cliente' : 'Editar cliente')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _cedulaRncCtrl,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: InputDecoration(
                    labelText: 'Cédula / RNC',
                    helperText:
                        'La consulta se realiza al completar 9 u 11 dígitos.',
                    suffixIcon: _consultandoDgii
                        ? const Padding(
                            padding: EdgeInsets.all(12),
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : IconButton(
                            tooltip: 'Consultar DGII',
                            onPressed: () => _consultarDgii(force: true),
                            icon: const Icon(Icons.manage_search),
                          ),
                  ),
                  validator: (v) => Validators.cedulaORnc(v, optional: true),
                  onChanged: _onDocumentChanged,
                ),
                if (_mensajeConsulta != null) ...[
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        _consultaExitosa
                            ? Icons.verified_outlined
                            : Icons.info_outline,
                        color: _consultaExitosa
                            ? Colors.green
                            : Theme.of(context).colorScheme.error,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_mensajeConsulta!)),
                    ],
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: _nombreCtrl,
                  textCapitalization: TextCapitalization.words,
                  decoration:
                      const InputDecoration(labelText: 'Nombre / Razón social'),
                  validator: (v) => Validators.required(v, label: 'El nombre'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _nombreComercialCtrl,
                  textCapitalization: TextCapitalization.words,
                  decoration:
                      const InputDecoration(labelText: 'Nombre comercial'),
                ),
                if (_estadoDgii != null ||
                    _tipoContribuyente != null ||
                    _categoriaDgii != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    [
                      if (_estadoDgii != null) 'Estado: $_estadoDgii',
                      if (_tipoContribuyente != null)
                        'Tipo: $_tipoContribuyente',
                      if (_categoriaDgii != null) 'Categoría: $_categoriaDgii',
                    ].join(' · '),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: _telefonoCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                  validator: (v) => Validators.phoneRD(v, optional: true),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _whatsappCtrl,
                  keyboardType: TextInputType.phone,
                  decoration:
                      const InputDecoration(labelText: 'WhatsApp (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration:
                      const InputDecoration(labelText: 'Correo (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _direccionCtrl,
                  decoration:
                      const InputDecoration(labelText: 'Dirección (opcional)'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _limiteCreditoCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                      labelText: 'Límite de crédito', prefixText: 'RD\$ '),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _notasCtrl,
                  decoration:
                      const InputDecoration(labelText: 'Notas (opcional)'),
                  maxLines: 3,
                ),
                const SizedBox(height: 20),
                LoadingButton(
                    label: 'Guardar',
                    isLoading: _cargando,
                    onPressed: _guardar),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
