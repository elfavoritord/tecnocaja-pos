import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/routes.dart';
import '../../../shared/widgets/app_empty_state.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notificaciones'),
        leading: BackButton(
          onPressed: () => context.go(AppRoutes.dashboard),
        ),
      ),
      body: const AppEmptyState(
        title: 'Aun no hay notificaciones',
        message:
            'Cuando el sistema genere alertas, avisos o recordatorios, apareceran aqui.',
        icon: Icons.notifications_none_rounded,
      ),
    );
  }
}
