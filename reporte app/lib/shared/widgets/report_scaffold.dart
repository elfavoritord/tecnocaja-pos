import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'app_drawer.dart';

/// Scaffold compartido para todos los módulos de reporte.
/// Incluye el drawer de navegación (menú ≡) y escala automáticamente
/// el contenido para que sea compacto en pantallas pequeñas.
class ReportScaffold extends StatelessWidget {
  final String title;
  final Widget body;
  final List<Widget>? actions;
  final Widget? floatingActionButton;
  final PreferredSizeWidget? bottom; // ej: TabBar

  const ReportScaffold({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.floatingActionButton,
    this.bottom,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      drawer: const AppDrawer(),
      appBar: AppBar(
        title: Text(title),
        actions: [
          ...?actions,
          IconButton(
            icon: const Icon(Icons.home_rounded),
            tooltip: 'Ir al inicio',
            onPressed: () => context.go('/dashboard'),
          ),
        ],
        bottom: bottom,
      ),
      body: body,
      floatingActionButton: floatingActionButton,
    );
  }
}

/// Devuelve padding horizontal adaptado al tamaño de pantalla.
/// En móviles pequeños (<360px) usa 12, en el resto 16.
double hPad(BuildContext context) {
  return MediaQuery.sizeOf(context).width < 360 ? 12.0 : 16.0;
}

/// Devuelve un padding EdgeInsets horizontal adaptado.
EdgeInsets hPadding(BuildContext context, {double top = 0, double bottom = 0}) {
  final h = hPad(context);
  return EdgeInsets.fromLTRB(h, top, h, bottom);
}

/// Devuelve si la pantalla es "pequeña" (< 400px de ancho).
bool isCompact(BuildContext context) =>
    MediaQuery.sizeOf(context).width < 400;

/// Espaciado vertical entre secciones: 12 en compacto, 16 normal.
double sectionGap(BuildContext context) => isCompact(context) ? 10.0 : 14.0;

/// Tamaño de fuente para títulos de KPI: más pequeño en móvil.
double kpiTitleSize(BuildContext context) => isCompact(context) ? 18.0 : 22.0;
