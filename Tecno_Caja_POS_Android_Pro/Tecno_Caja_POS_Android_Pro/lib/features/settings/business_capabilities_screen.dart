import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/business/business_capabilities.dart';
import '../../core/constants/roles.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/repositories/configuracion_repository.dart';
import '../../data/repositories/empresa_repository.dart';
import '../../widgets/loading_button.dart';

class BusinessCapabilitiesScreen extends ConsumerStatefulWidget {
  const BusinessCapabilitiesScreen({super.key});

  @override
  ConsumerState<BusinessCapabilitiesScreen> createState() =>
      _BusinessCapabilitiesScreenState();
}

class _BusinessCapabilitiesScreenState
    extends ConsumerState<BusinessCapabilitiesScreen> {
  String? _businessType;
  Set<String> _selected = {};
  bool _loading = true;
  bool _saving = false;

  bool get _canEdit {
    final role = ref.read(authControllerProvider).usuario?.rol;
    return role == RolBase.administradorGeneral ||
        role == RolBase.administradorSucursal;
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final config = await ref.read(configuracionRepositoryProvider).obtener();
    final company = await ref.read(empresaRepositoryProvider).actual();
    final profile = BusinessCatalog.byValue(
      config.businessType ?? company?.tipoNegocio,
    );
    if (!mounted) return;
    setState(() {
      _businessType = profile.code;
      _selected = config.businessCapabilities.isEmpty
          ? profile.capabilities.map((item) => item.code).toSet()
          : Set<String>.from(config.businessCapabilities);
      _loading = false;
    });
  }

  void _changeBusinessType(String value) {
    final profile = BusinessCatalog.byValue(value);
    setState(() {
      _businessType = profile.code;
      _selected = profile.capabilities.map((item) => item.code).toSet();
    });
  }

  Future<void> _save() async {
    if (!_canEdit || _businessType == null) return;
    setState(() => _saving = true);
    String? remoteWarning;
    try {
      final profile = BusinessCatalog.byValue(_businessType);
      await ref.read(configuracionControllerProvider.notifier).actualizar(
            (config) => config.copyWith(
              businessType: profile.code,
              businessCapabilities: _selected,
            ),
          );

      final company = await ref.read(empresaRepositoryProvider).actual();
      if (company != null) {
        await ref.read(empresaRepositoryProvider).actualizar(
              company.copyWith(tipoNegocio: profile.label),
            );
        final remoteId = company.remotoId;
        if (remoteId != null && remoteId.isNotEmpty) {
          try {
            await ref
                .read(cloudFunctionsServiceProvider)
                .updateBusinessCapabilities(
                  businessId: remoteId,
                  businessType: profile.label,
                  businessTypeCode: profile.code,
                  capabilities: _selected.toList()..sort(),
                );
          } catch (_) {
            remoteWarning =
                'Se guardó en este dispositivo. La nube no respondió; vuelve a guardar cuando tengas conexión.';
          }
        }
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(remoteWarning ?? 'Configuración del negocio guardada.'),
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final profile = BusinessCatalog.byValue(_businessType);
    return Scaffold(
      appBar: AppBar(title: const Text('Tipo de negocio y capacidades')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          DropdownButtonFormField<String>(
            initialValue: profile.code,
            isExpanded: true,
            menuMaxHeight: 320,
            decoration: const InputDecoration(labelText: 'Tipo de negocio'),
            items: BusinessCatalog.profiles
                .map(
                  (item) => DropdownMenuItem(
                    value: item.code,
                    child: Text(item.label, overflow: TextOverflow.ellipsis),
                  ),
                )
                .toList(),
            onChanged: _canEdit
                ? (value) {
                    if (value != null) _changeBusinessType(value);
                  }
                : null,
          ),
          const SizedBox(height: 20),
          Text(
            'Capacidades activas',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          for (final capability in BusinessCapability.values)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _selected.contains(capability.code),
              title: Text(capability.label),
              subtitle: Text(capability.description),
              onChanged: _canEdit
                  ? (active) {
                      setState(() {
                        if (active) {
                          _selected.add(capability.code);
                        } else {
                          _selected.remove(capability.code);
                        }
                      });
                    }
                  : null,
            ),
          const SizedBox(height: 16),
          LoadingButton(
            label: 'Guardar configuración',
            icon: Icons.save_outlined,
            isLoading: _saving,
            onPressed: _canEdit ? _save : null,
          ),
          if (!_canEdit)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: Text(
                'Solo un administrador puede cambiar estas opciones.',
                textAlign: TextAlign.center,
              ),
            ),
        ],
      ),
    );
  }
}
