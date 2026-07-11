class FiscalEvent {
  final String nombre;
  final String tipo;
  final int mes;
  final int dia;
  final String descripcion;
  final String color;

  const FiscalEvent({
    required this.nombre,
    required this.tipo,
    required this.mes,
    required this.dia,
    required this.descripcion,
    required this.color,
  });
}

class FiscalCalendar {
  FiscalCalendar._();

  // Calendario fiscal RD — DGII 2025/2026
  // ITBIS mensual: día 20 de cada mes
  // IR-17 (retención ISR asalariados): día 10 de cada mes
  // Anticipos (Persona Jurídica): 15 de jul, 15 de sep, 15 de nov
  // ISR Anual (Persona Jurídica): 120 días después del cierre fiscal
  // IR-3 (Persona Física): 31 de marzo cada año

  static List<FiscalEvent> getEventsForYear(int year) {
    final events = <FiscalEvent>[];

    // ITBIS mensual — día 20 de cada mes
    for (int m = 1; m <= 12; m++) {
      events.add(FiscalEvent(
        nombre: 'ITBIS',
        tipo: 'itbis',
        mes: m,
        dia: 20,
        descripcion: 'Declaración y pago mensual de ITBIS',
        color: '#2563EB',
      ));
    }

    // IR-17 (Retención ISR empleados) — día 10 de cada mes
    for (int m = 1; m <= 12; m++) {
      events.add(FiscalEvent(
        nombre: 'IR-17',
        tipo: 'ir17',
        mes: m,
        dia: 10,
        descripcion: 'Retención ISR empleados (planilla)',
        color: '#7C3AED',
      ));
    }

    // Anticipos (Persona Jurídica) — 15 de julio, septiembre, noviembre
    for (final mes in [7, 9, 11]) {
      events.add(FiscalEvent(
        nombre: 'Anticipos ISR',
        tipo: 'anticipos',
        mes: mes,
        dia: 15,
        descripcion: 'Pago de anticipo ISR Persona Jurídica',
        color: '#F59E0B',
      ));
    }

    // IR-3 (Persona Física) — 31 de marzo
    events.add(FiscalEvent(
      nombre: 'IR-3',
      tipo: 'ir3',
      mes: 3,
      dia: 31,
      descripcion: 'Declaración anual Persona Física (IR-3)',
      color: '#0EA5E9',
    ));

    // IR-2 (Herencias y donaciones) — cuando aplique
    events.add(FiscalEvent(
      nombre: 'IR-2',
      tipo: 'ir2',
      mes: 3,
      dia: 31,
      descripcion: 'Declaración Herencias y Donaciones (IR-2)',
      color: '#10B981',
    ));

    // TSS (Seguridad Social) — día 3 de cada mes
    for (int m = 1; m <= 12; m++) {
      events.add(FiscalEvent(
        nombre: 'TSS',
        tipo: 'tss',
        mes: m,
        dia: 3,
        descripcion: 'Pago mensual de Seguridad Social (TSS)',
        color: '#EC4899',
      ));
    }

    return events;
  }

  static String getTipoLabel(String tipo) {
    switch (tipo) {
      case 'itbis': return 'ITBIS';
      case 'ir17': return 'IR-17';
      case 'ir3': return 'IR-3';
      case 'ir2': return 'IR-2';
      case 'ir1': return 'IR-1';
      case 'isr': return 'ISR';
      case 'anticipos': return 'Anticipos';
      case 'retenciones': return 'Retenciones';
      case 'tss': return 'TSS';
      default: return tipo.toUpperCase();
    }
  }

  static const tiposDeclaracion = [
    'ITBIS',
    'IR-17',
    'IR-3',
    'IR-2',
    'IR-1',
    'ISR',
    'Anticipos',
    'Retenciones',
  ];

  static const estadosDeclaracion = [
    'pendiente',
    'en_proceso',
    'enviada',
    'aprobada',
    'rechazada',
    'vencida',
  ];
}
