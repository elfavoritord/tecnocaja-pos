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
  testWidgets('LoginScreen muestra marca, campos y botones principales', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: LoginScreen()),
      ),
    );
    await tester.pump();

    expect(find.text('Tecno Caja POS'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'Correo electrónico'), findsOneWidget);
    expect(find.text('Iniciar sesión'), findsOneWidget);
    expect(find.text('Continuar con Google'), findsOneWidget);
  });
}
