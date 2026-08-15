import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/errors/app_exception.dart';
import '../../core/theme/app_colors.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../data/repositories/fiscal_repository.dart';
import '../../widgets/loading_button.dart';

class EcfCertificationScreen extends ConsumerStatefulWidget {
  const EcfCertificationScreen({super.key});

  @override
  ConsumerState<EcfCertificationScreen> createState() =>
      _EcfCertificationScreenState();
}

class _EcfCertificationScreenState
    extends ConsumerState<EcfCertificationScreen> {
  String? _businessId;
  EcfCertificationProcess? _process;
  bool _loading = true;
  bool _working = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final company = await ref.read(empresaRepositoryProvider).actual();
      final businessId = company?.remotoId;
      if (businessId == null || businessId.isEmpty) {
        throw const ValidationException(
          message:
              'La empresa debe estar vinculada a la nube para certificar e-CF.',
        );
      }
      final process = await ref
          .read(fiscalRepositoryProvider)
          .obtenerCertificacion(businessId);
      if (!mounted) return;
      setState(() {
        _businessId = businessId;
        _process = process;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _message(error);
        _loading = false;
      });
    }
  }

  Future<void> _start() async {
    final businessId = _businessId;
    if (businessId == null) return;
    setState(() => _working = true);
    try {
      final process = await ref
          .read(fiscalRepositoryProvider)
          .iniciarCertificacion(businessId);
      if (!mounted) return;
      setState(() => _process = process);
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _openPortal() async {
    final rawUrl = _process?.portalUrl;
    if (rawUrl == null || rawUrl.isEmpty) return;
    final opened = await launchUrl(
      Uri.parse(rawUrl),
      mode: LaunchMode.externalApplication,
    );
    if (!opened && mounted) {
      _showError('No se pudo abrir el portal de certificación DGII.');
    }
  }

  Future<void> _confirmManual(EcfCertificationStep step) async {
    final controller = TextEditingController();
    final reference = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Confirmar paso ${step.id}'),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: 'Referencia o evidencia del portal DGII',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () {
              final value = controller.text.trim();
              if (value.length >= 3) Navigator.pop(context, value);
            },
            child: const Text('Confirmar'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (reference == null || !mounted) return;

    final businessId = _businessId;
    if (businessId == null) return;
    setState(() => _working = true);
    try {
      final process =
          await ref.read(fiscalRepositoryProvider).confirmarPasoCertificacion(
                businessId: businessId,
                stepId: step.id,
                reference: reference,
              );
      if (!mounted) return;
      setState(() => _process = process);
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _validateUrls(EcfCertificationStep step) async {
    final controller = TextEditingController(
      text: _process?.recommendedServiceBaseUrl ?? '',
    );
    final baseUrl = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Validar URLs del paso ${step.id}'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'URL base HTTPS'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancelar'),
          ),
          FilledButton.icon(
            onPressed: () {
              final value = controller.text.trim();
              if (value.startsWith('https://')) Navigator.pop(context, value);
            },
            icon: const Icon(Icons.verified_outlined),
            label: const Text('Validar'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (baseUrl == null || !mounted) return;

    final businessId = _businessId;
    if (businessId == null) return;
    setState(() => _working = true);
    try {
      final process =
          await ref.read(fiscalRepositoryProvider).validarUrlsCertificacion(
                businessId: businessId,
                stepId: step.id,
                baseUrl: baseUrl,
              );
      if (!mounted) return;
      setState(() => _process = process);
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _uploadCertificate() async {
    final selection = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['p12', 'pfx'],
      withData: true,
    );
    final file = selection == null || selection.files.isEmpty
        ? null
        : selection.files.single;
    final bytes = file?.bytes;
    if (file == null || bytes == null || !mounted) return;
    if (bytes.length > 60 * 1024) {
      _showError('El certificado debe pesar menos de 60 KB.');
      return;
    }

    final passwordController = TextEditingController();
    final password = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Contraseña del certificado'),
        content: TextField(
          controller: passwordController,
          autofocus: true,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'Contraseña'),
          onSubmitted: (value) {
            if (value.isNotEmpty) Navigator.pop(context, value);
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () {
              if (passwordController.text.isNotEmpty) {
                Navigator.pop(context, passwordController.text);
              }
            },
            child: const Text('Validar y proteger'),
          ),
        ],
      ),
    );
    passwordController.clear();
    passwordController.dispose();
    if (password == null || !mounted) return;

    final businessId = _businessId;
    if (businessId == null) return;
    setState(() => _working = true);
    try {
      final process =
          await ref.read(fiscalRepositoryProvider).cargarCertificado(
                businessId: businessId,
                fileName: file.name,
                certificateBase64: base64Encode(bytes),
                password: password,
              );
      if (!mounted) return;
      setState(() => _process = process);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Certificado validado y protegido.')),
      );
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(_message(error)),
        backgroundColor: AppColors.danger,
      ),
    );
  }

  String _message(Object error) {
    return error is AppException ? error.message : error.toString();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Certificación e-CF'),
        actions: [
          if (_process != null)
            IconButton(
              tooltip: 'Abrir portal DGII',
              onPressed: _openPortal,
              icon: const Icon(Icons.open_in_new),
            ),
          IconButton(
            tooltip: 'Actualizar estado',
            onPressed: _working ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _ErrorView(message: _error!, retry: _load)
              : _process == null
                  ? _StartView(working: _working, start: _start)
                  : _ProcessView(
                      process: _process!,
                      working: _working,
                      refresh: _load,
                      confirmManual: _confirmManual,
                      validateUrls: _validateUrls,
                      uploadCertificate: _uploadCertificate,
                    ),
    );
  }
}

class _StartView extends StatelessWidget {
  const _StartView({required this.working, required this.start});

  final bool working;
  final VoidCallback start;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Icon(Icons.workspace_premium_outlined, size: 56),
        const SizedBox(height: 16),
        Text(
          'Proceso de certificación DGII',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        const Text(
          'El progreso se guarda por empresa en el servicio fiscal central. '
          'Los pasos automáticos solo se completan cuando el motor fiscal o el '
          'gateway reciben evidencia real.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        LoadingButton(
          label: 'Iniciar certificación',
          isLoading: working,
          onPressed: start,
        ),
      ],
    );
  }
}

class _ProcessView extends StatelessWidget {
  const _ProcessView({
    required this.process,
    required this.working,
    required this.refresh,
    required this.confirmManual,
    required this.validateUrls,
    required this.uploadCertificate,
  });

  final EcfCertificationProcess process;
  final bool working;
  final Future<void> Function() refresh;
  final Future<void> Function(EcfCertificationStep) confirmManual;
  final Future<void> Function(EcfCertificationStep) validateUrls;
  final Future<void> Function() uploadCertificate;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        process.completed
                            ? Icons.verified
                            : Icons.fact_check_outlined,
                        color: process.completed
                            ? AppColors.success
                            : AppColors.primary,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          process.completed
                              ? 'Certificación completada'
                              : 'Certificación en curso',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      Text('${process.progress}%'),
                    ],
                  ),
                  const SizedBox(height: 12),
                  LinearProgressIndicator(value: process.progress / 100),
                  const SizedBox(height: 12),
                  Text(process.razonSocial),
                  Text('RNC/Cédula: ${process.rnc}'),
                  Text('Ambiente: ${process.environment}'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              border: Border.all(color: Theme.of(context).dividerColor),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Icon(
                  process.certificateStatus == 'valid'
                      ? Icons.security
                      : Icons.gpp_maybe_outlined,
                  color: process.certificateStatus == 'valid'
                      ? AppColors.success
                      : AppColors.warning,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        process.certificateStatus == 'valid'
                            ? 'Certificado digital válido'
                            : 'Certificado digital requerido',
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      if (process.certificateSubject != null)
                        Text(process.certificateSubject!,
                            style: Theme.of(context).textTheme.bodySmall),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: process.certificateStatus == 'valid'
                      ? 'Reemplazar certificado'
                      : 'Cargar certificado',
                  onPressed: working ? null : uploadCertificate,
                  icon: const Icon(Icons.upload_file),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Text('Pasos de certificación',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          ...process.steps.map((step) => _StepRow(
                step: step,
                isCurrent: step.id == process.currentStep,
                working: working,
                confirmManual: confirmManual,
                validateUrls: validateUrls,
              )),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.step,
    required this.isCurrent,
    required this.working,
    required this.confirmManual,
    required this.validateUrls,
  });

  final EcfCertificationStep step;
  final bool isCurrent;
  final bool working;
  final Future<void> Function(EcfCertificationStep) confirmManual;
  final Future<void> Function(EcfCertificationStep) validateUrls;

  @override
  Widget build(BuildContext context) {
    final canAct = isCurrent && !working && !step.completed;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(
          color: isCurrent ? AppColors.primary : Theme.of(context).dividerColor,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 34,
            height: 34,
            child: step.completed
                ? const Icon(Icons.check_circle, color: AppColors.success)
                : Center(child: Text('${step.id}')),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(step.label, style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 2),
                Text(_verificationLabel(step.verification),
                    style: Theme.of(context).textTheme.bodySmall),
                if (canAct && step.verification == 'manual') ...[
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: () => confirmManual(step),
                    icon: const Icon(Icons.task_alt),
                    label: const Text('Registrar validación'),
                  ),
                ],
                if (canAct && step.verification == 'urls') ...[
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: () => validateUrls(step),
                    icon: const Icon(Icons.verified_outlined),
                    label: const Text('Validar servicios'),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _verificationLabel(String value) {
    switch (value) {
      case 'manual':
        return 'Confirmación registrada desde el portal DGII';
      case 'urls':
        return 'Verificación HTTPS desde el servidor fiscal';
      case 'gateway_received':
        return 'Se completa al recibir un e-CF de prueba';
      case 'gateway_approval':
        return 'Se completa al recibir una aprobación comercial';
      default:
        return 'Verificación del motor fiscal central';
    }
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.retry});

  final String message;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppColors.danger),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: retry, child: const Text('Reintentar')),
          ],
        ),
      ),
    );
  }
}
