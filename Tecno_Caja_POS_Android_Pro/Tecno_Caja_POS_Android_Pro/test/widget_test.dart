import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tecno_caja_pos_android/features/auth/login_screen.dart';

// Prueba LoginScreen aislada (sin Firebase/DB reales): la pantalla no lee
// ningun provider durante build(), solo dentro de los callbacks de los
// botones, asi que no hace falta overridear databaseProvider/Firebase aqui.
// La cobertura de flujo completo (router + auth + DB fake) vive en
// integration_test, ver Fase de pruebas.
void main() {
  testWidgets('LoginScreen muestra marca, campos y botones principales',
      (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: LoginScreen()),
      ),
    );
    await tester.pump();

    expect(find.text('Tecno Caja POS'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Correo electrónico'),
        findsOneWidget);
    expect(find.text('Iniciar sesión sin POS'), findsOneWidget);
    expect(find.text('Continuar con Google'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('LoginScreen no desborda en un teléfono angosto', (tester) async {
    tester.view.physicalSize = const Size(320, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: LoginScreen()),
      ),
    );
    await tester.pump();

    expect(find.text('Crear una cuenta'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
