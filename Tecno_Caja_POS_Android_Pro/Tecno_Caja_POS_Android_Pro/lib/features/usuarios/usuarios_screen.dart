import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/roles.dart';
import '../../core/errors/app_exception.dart';
import '../../core/providers/service_providers.dart';
import '../../data/auth/auth_controller.dart';
import '../../data/cloud/cloud_functions_service.dart';
import '../../data/repositories/usuario_repository.dart';
import '../../domain/entities/usuario.dart';

class UsuariosScreen extends ConsumerStatefulWidget {
  const UsuariosScreen({super.key});

  @override
  ConsumerState<UsuariosScreen> createState() => _UsuariosScreenState();
}

class _UsuariosScreenState extends ConsumerState<UsuariosScreen> {
  final _search = TextEditingController();
  bool _onlyActive = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<List<Usuario>> _load() async {
    final businessId = ref.read(authControllerProvider).empresaId;
    if (businessId == null) return const [];
    final users =
        await ref.read(usuarioRepositoryProvider).deEmpresa(businessId);
    final query = _search.text.trim().toLowerCase();
    return users.where((user) {
      if (_onlyActive && !user.activo) return false;
      if (query.isEmpty) return true;
      return user.nombreCompleto.toLowerCase().contains(query) ||
          user.usuario.toLowerCase().contains(query) ||
          (user.email?.toLowerCase().contains(query) ?? false);
    }).toList();
  }

  bool get _canManage {
    final role = ref.read(authControllerProvider).usuario?.rol;
    return role == RolBase.administradorGeneral ||
        role == RolBase.administradorSucursal;
  }

  Future<void> _openForm([Usuario? user]) async {
    if (!_canManage) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('No tienes permiso para administrar usuarios.')),
      );
      return;
    }
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _UserDialog(user: user),
    );
    if (saved == true && mounted) setState(() {});
  }

  Future<void> _changeStatus(Usuario user) async {
    if (!_canManage) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${user.activo ? 'Desactivar' : 'Reactivar'} usuario'),
        content: Text(
          user.activo
              ? '${user.nombreCompleto} ya no podrá iniciar sesión. Sus ventas y operaciones se conservarán.'
              : '${user.nombreCompleto} podrá iniciar sesión nuevamente.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(user.activo ? 'Desactivar' : 'Reactivar'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final uid = user.firebaseUid;
    if (uid == null || uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Este usuario todavía no tiene una cuenta móvil vinculada.',
          ),
        ),
      );
      return;
    }
    try {
      await ref.read(cloudFunctionsServiceProvider).updateBusinessUser({
        'uid': uid,
        'displayName': user.nombreCompleto,
        'email': user.email,
        'role': _cloudRole(user.rol),
        'isActive': !user.activo,
      });
      await ref.read(usuarioRepositoryProvider).actualizar(
            user.copyWith(activo: !user.activo),
          );
      if (!mounted) return;
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            user.activo ? 'Usuario desactivado.' : 'Usuario reactivado.',
          ),
        ),
      );
    } catch (error) {
      if (!mounted) return;
      final message = error is AppException
          ? error.message
          : 'No se pudo cambiar el estado del usuario.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message)),
      );
    }
  }

  String _cloudRole(RolBase role) => switch (role) {
        RolBase.administradorGeneral => 'admin',
        RolBase.administradorSucursal => 'branch_admin',
        RolBase.supervisor => 'supervisor',
        RolBase.cajero => 'cashier',
        RolBase.delivery => 'delivery',
        RolBase.contador => 'accountant',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Usuarios y administración'),
        actions: [
          IconButton(
            tooltip: 'Solo activos',
            onPressed: () => setState(() => _onlyActive = !_onlyActive),
            icon: Icon(
                _onlyActive ? Icons.filter_alt : Icons.filter_alt_outlined),
          ),
        ],
      ),
      floatingActionButton: _canManage
          ? FloatingActionButton.extended(
              onPressed: _openForm,
              icon: const Icon(Icons.person_add),
              label: const Text('Usuario'),
            )
          : null,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: SearchBar(
              controller: _search,
              hintText: 'Buscar por nombre, usuario o correo',
              leading: const Icon(Icons.search),
              onChanged: (_) => setState(() {}),
            ),
          ),
          Expanded(
            child: FutureBuilder(
              future: _load(),
              builder: (context, snapshot) {
                if (!snapshot.hasData) {
                  return const Center(child: CircularProgressIndicator());
                }
                final users = snapshot.data!;
                if (users.isEmpty) {
                  return const Center(
                      child: Text('No hay usuarios para mostrar'));
                }
                return RefreshIndicator(
                  onRefresh: () async => setState(() {}),
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 100),
                    itemCount: users.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final user = users[index];
                      return ListTile(
                        onTap: () => _openForm(user),
                        leading: CircleAvatar(
                          child: Text(user.nombreCompleto.isEmpty
                              ? '?'
                              : user.nombreCompleto[0].toUpperCase()),
                        ),
                        title: Text(user.nombreCompleto),
                        subtitle: Text(
                          '${user.rol.etiqueta} · ${user.email ?? user.usuario}',
                          maxLines: 2,
                        ),
                        trailing: _canManage
                            ? PopupMenuButton<String>(
                                tooltip: 'Acciones del usuario',
                                onSelected: (action) {
                                  if (action == 'edit') _openForm(user);
                                  if (action == 'status') _changeStatus(user);
                                },
                                itemBuilder: (context) => [
                                  const PopupMenuItem(
                                    value: 'edit',
                                    child: ListTile(
                                      contentPadding: EdgeInsets.zero,
                                      leading: Icon(Icons.edit_outlined),
                                      title: Text('Editar'),
                                    ),
                                  ),
                                  PopupMenuItem(
                                    value: 'status',
                                    child: ListTile(
                                      contentPadding: EdgeInsets.zero,
                                      leading: Icon(
                                        user.activo
                                            ? Icons.person_off_outlined
                                            : Icons.person_add_alt,
                                      ),
                                      title: Text(
                                        user.activo
                                            ? 'Desactivar'
                                            : 'Reactivar',
                                      ),
                                    ),
                                  ),
                                ],
                                child: Chip(
                                  avatar: Icon(
                                    user.activo
                                        ? Icons.check_circle
                                        : Icons.block,
                                    size: 16,
                                    color:
                                        user.activo ? Colors.green : Colors.red,
                                  ),
                                  label:
                                      Text(user.activo ? 'Activo' : 'Inactivo'),
                                ),
                              )
                            : Chip(
                                avatar: Icon(
                                  user.activo
                                      ? Icons.check_circle
                                      : Icons.block,
                                  size: 16,
                                  color:
                                      user.activo ? Colors.green : Colors.red,
                                ),
                                label:
                                    Text(user.activo ? 'Activo' : 'Inactivo'),
                              ),
                      );
                    },
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _UserDialog extends ConsumerStatefulWidget {
  const _UserDialog({this.user});
  final Usuario? user;

  @override
  ConsumerState<_UserDialog> createState() => _UserDialogState();
}

class _UserDialogState extends ConsumerState<_UserDialog> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _lastName;
  late final TextEditingController _username;
  late final TextEditingController _email;
  late final TextEditingController _password;
  late final TextEditingController _phone;
  late RolBase _role;
  late bool _active;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final user = widget.user;
    _name = TextEditingController(text: user?.nombre);
    _lastName = TextEditingController(text: user?.apellido);
    _username = TextEditingController(text: user?.usuario);
    _email = TextEditingController(text: user?.email);
    _password = TextEditingController();
    _phone = TextEditingController(text: user?.telefono);
    _role = user?.rol ?? RolBase.cajero;
    _active = user?.activo ?? true;
  }

  @override
  void dispose() {
    _name.dispose();
    _lastName.dispose();
    _username.dispose();
    _email.dispose();
    _password.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _saving = true);
    try {
      final repository = ref.read(usuarioRepositoryProvider);
      final existing = widget.user;
      if (existing == null) {
        final auth = ref.read(authControllerProvider);
        final cloudUser =
            await ref.read(cloudFunctionsServiceProvider).createBusinessUser({
          'displayName': '${_name.text.trim()} ${_lastName.text.trim()}'.trim(),
          'email': _email.text.trim(),
          'password': _password.text,
          'role': _cloudRole(_role),
        });
        final deviceId = await ref
            .read(secureSessionServiceProvider)
            .obtenerOCrearDeviceId();
        await repository.crear(
          empresaId: auth.empresaId!,
          sucursalId: auth.usuario?.sucursalId,
          nombre: _name.text.trim(),
          apellido: _lastName.text.trim(),
          usuario: _username.text.trim(),
          email: _email.text.trim(),
          telefono: _phone.text.trim().isEmpty ? null : _phone.text.trim(),
          rol: _role,
          firebaseUid: cloudUser['uid']?.toString(),
          dispositivoId: deviceId,
        );
      } else {
        final result =
            await ref.read(cloudFunctionsServiceProvider).updateBusinessUser({
          if (existing.firebaseUid?.isNotEmpty == true)
            'uid': existing.firebaseUid,
          'lookupEmail': existing.email,
          'posUserId': existing.remotoId,
          'displayName': '${_name.text.trim()} ${_lastName.text.trim()}'.trim(),
          'email': _email.text.trim(),
          if (_password.text.isNotEmpty) 'password': _password.text,
          'role': _cloudRole(_role),
          'isActive': _active,
        });
        await repository.actualizar(existing.copyWith(
          nombre: _name.text.trim(),
          apellido: _lastName.text.trim(),
          email: _email.text.trim(),
          telefono: _phone.text.trim(),
          rol: _role,
          activo: _active,
          firebaseUid: result['uid']?.toString(),
        ));
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      final message = error is AppException
          ? error.message
          : 'No se pudo guardar el usuario.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(message)),
      );
    }
  }

  String _cloudRole(RolBase role) => switch (role) {
        RolBase.administradorGeneral => 'admin',
        RolBase.administradorSucursal => 'branch_admin',
        RolBase.supervisor => 'supervisor',
        RolBase.cajero => 'cashier',
        RolBase.delivery => 'delivery',
        RolBase.contador => 'accountant',
      };

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.user == null ? 'Nuevo usuario' : 'Editar usuario'),
      content: SizedBox(
        width: 480,
        child: Form(
          key: _form,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextFormField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: 'Nombre'),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? 'Es obligatorio'
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _lastName,
                  decoration: const InputDecoration(labelText: 'Apellido'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _username,
                  enabled: widget.user == null,
                  decoration: const InputDecoration(labelText: 'Usuario'),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? 'Es obligatorio'
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: 'Correo'),
                  validator: (value) {
                    if (widget.user != null &&
                        (value?.trim().isEmpty ?? true)) {
                      return null;
                    }
                    final email = value?.trim() ?? '';
                    if (email.isEmpty) return 'Es obligatorio';
                    if (!email.contains('@') || !email.contains('.')) {
                      return 'Escribe un correo válido';
                    }
                    return null;
                  },
                ),
                if (widget.user == null) ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _password,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Contraseña temporal',
                      helperText:
                          'El usuario iniciará con este correo y contraseña',
                    ),
                    validator: (value) => (value?.length ?? 0) < 6
                        ? 'Debe tener al menos 6 caracteres'
                        : null,
                  ),
                ] else ...[
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _password,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Nueva contraseña (opcional)',
                      helperText: 'Déjala vacía para conservar la contraseña',
                    ),
                    validator: (value) =>
                        value != null && value.isNotEmpty && value.length < 6
                            ? 'Debe tener al menos 6 caracteres'
                            : null,
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Teléfono'),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<RolBase>(
                  initialValue: _role,
                  decoration: const InputDecoration(labelText: 'Rol'),
                  items: RolBase.values
                      .map((role) => DropdownMenuItem(
                          value: role, child: Text(role.etiqueta)))
                      .toList(),
                  onChanged: (value) => setState(() => _role = value ?? _role),
                ),
                if (widget.user != null)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Usuario activo'),
                    value: _active,
                    onChanged: (value) => setState(() => _active = value),
                  ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Guardando…' : 'Guardar'),
        ),
      ],
    );
  }
}
