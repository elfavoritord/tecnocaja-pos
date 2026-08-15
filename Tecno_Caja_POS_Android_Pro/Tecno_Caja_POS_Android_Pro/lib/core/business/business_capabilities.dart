enum BusinessCapability {
  expiration('expiration', 'Vencimientos',
      'Control de fechas de vencimiento para cualquier producto.'),
  batches('batches', 'Lotes', 'Existencia, costo y trazabilidad por lote.'),
  medication('medication', 'Datos de medicamentos',
      'Laboratorio, principio activo, presentación y registro sanitario.'),
  fefo('fefo', 'Salida FEFO',
      'Prioriza lotes válidos con vencimiento más cercano.'),
  expirationAlerts('expiration_alerts', 'Alertas de vencimiento',
      'Avisos escalonados para productos próximos a vencer o vencidos.'),
  tables('tables', 'Mesas', 'Cuentas abiertas y estados por mesa.'),
  kitchen('kitchen', 'Cocina y comandas',
      'Preparación, comandas, precuentas y estados de cocina.'),
  modifiers('modifiers', 'Modificadores y extras',
      'Tamaños, ingredientes, extras y notas de preparación.'),
  combos('combos', 'Combos', 'Productos agrupados y ofertas combinadas.'),
  delivery('delivery', 'Delivery', 'Despacho, repartidor y seguimiento.'),
  orderModes('order_modes', 'Modalidades de pedido',
      'Comer aquí, para llevar y delivery.'),
  serialTracking('serial_tracking', 'Números de serie',
      'Control individual de unidades serializadas.'),
  imeiTracking('imei_tracking', 'IMEI',
      'Asigna el IMEI exacto a cada venta e impide reutilizarlo.'),
  warranty('warranty', 'Garantías', 'Plazos y fecha de garantía por unidad.'),
  variants(
      'variants', 'Variantes', 'Existencia y SKU independientes por variante.'),
  sizeColor('size_color', 'Tallas y colores',
      'Matrices de talla, color, género, modelo y temporada.'),
  measurements('measurements', 'Unidades de medida',
      'Pie, metro, pulgada, peso, volumen, caja, paquete y rollo.'),
  fractionalSale('fractional_sale', 'Venta fraccionada',
      'Cantidades decimales para productos que se venden por medida.'),
  unitConversions('unit_conversions', 'Conversión de unidades',
      'Equivalencias de compra, inventario y venta.'),
  plu('plu', 'PLU', 'Identificación rápida de productos por PLU.'),
  weightedProducts('weighted_products', 'Productos por peso',
      'Venta por libra, kilogramo u otra unidad de peso.'),
  wholesalePrices('wholesale_prices', 'Precios mayoristas',
      'Precios por volumen o tipo de cliente.'),
  services('services', 'Servicios',
      'Catálogo y venta de servicios junto con productos.'),
  commissions('commissions', 'Comisiones',
      'Comisión por empleado y servicio realizado.'),
  appointments(
      'appointments', 'Citas', 'Agenda comercial de servicios y responsables.'),
  workOrders('work_orders', 'Órdenes de trabajo',
      'Diagnóstico, mano de obra, piezas y estado del trabajo.'),
  customerAssets('customer_assets', 'Vehículos y equipos',
      'Bienes del cliente asociados a presupuestos y trabajos.'),
  technicians(
      'technicians', 'Técnicos', 'Asignación del responsable de cada trabajo.'),
  estimates('estimates', 'Presupuestos',
      'Cotización previa vinculada a una orden de trabajo.'),
  pets('pets', 'Mascotas',
      'Datos comerciales básicos de mascotas y propietarios.'),
  recipes('recipes', 'Recetas y producción',
      'Ingredientes y rendimiento para productos elaborados.');

  const BusinessCapability(this.code, this.label, this.description);

  final String code;
  final String label;
  final String description;

  static BusinessCapability? fromCode(String code) {
    for (final capability in values) {
      if (capability.code == code) return capability;
    }
    return null;
  }
}

class BusinessTypeProfile {
  const BusinessTypeProfile({
    required this.code,
    required this.label,
    this.capabilities = const {},
  });

  final String code;
  final String label;
  final Set<BusinessCapability> capabilities;
}

class BusinessCatalog {
  const BusinessCatalog._();

  static const retail = <BusinessCapability>{
    BusinessCapability.plu,
    BusinessCapability.weightedProducts,
    BusinessCapability.wholesalePrices,
    BusinessCapability.expiration,
    BusinessCapability.expirationAlerts,
  };

  static const foodService = <BusinessCapability>{
    BusinessCapability.tables,
    BusinessCapability.kitchen,
    BusinessCapability.modifiers,
    BusinessCapability.combos,
    BusinessCapability.delivery,
    BusinessCapability.orderModes,
  };

  static const bakery = <BusinessCapability>{
    BusinessCapability.expiration,
    BusinessCapability.expirationAlerts,
    BusinessCapability.recipes,
    BusinessCapability.combos,
  };

  static const technology = <BusinessCapability>{
    BusinessCapability.serialTracking,
    BusinessCapability.imeiTracking,
    BusinessCapability.warranty,
    BusinessCapability.variants,
  };

  static const apparel = <BusinessCapability>{
    BusinessCapability.variants,
    BusinessCapability.sizeColor,
  };

  static const personalCare = <BusinessCapability>{
    BusinessCapability.services,
    BusinessCapability.commissions,
    BusinessCapability.appointments,
  };

  static const workshop = <BusinessCapability>{
    BusinessCapability.workOrders,
    BusinessCapability.customerAssets,
    BusinessCapability.technicians,
    BusinessCapability.estimates,
    BusinessCapability.serialTracking,
  };

  static const profiles = <BusinessTypeProfile>[
    BusinessTypeProfile(
        code: 'colmado', label: 'Colmado', capabilities: retail),
    BusinessTypeProfile(
        code: 'supermercado', label: 'Supermercado', capabilities: retail),
    BusinessTypeProfile(
        code: 'minimarket', label: 'Minimarket', capabilities: retail),
    BusinessTypeProfile(
      code: 'farmacia',
      label: 'Farmacia',
      capabilities: {
        BusinessCapability.expiration,
        BusinessCapability.batches,
        BusinessCapability.medication,
        BusinessCapability.fefo,
        BusinessCapability.expirationAlerts,
      },
    ),
    BusinessTypeProfile(
        code: 'restaurante', label: 'Restaurante', capabilities: foodService),
    BusinessTypeProfile(
        code: 'cafeteria', label: 'Cafetería', capabilities: foodService),
    BusinessTypeProfile(
        code: 'pizzeria', label: 'Pizzería', capabilities: foodService),
    BusinessTypeProfile(
        code: 'panaderia', label: 'Panadería', capabilities: bakery),
    BusinessTypeProfile(
        code: 'reposteria', label: 'Repostería', capabilities: bakery),
    BusinessTypeProfile(
      code: 'ferreteria',
      label: 'Ferretería',
      capabilities: {
        BusinessCapability.measurements,
        BusinessCapability.fractionalSale,
        BusinessCapability.unitConversions,
        BusinessCapability.wholesalePrices,
      },
    ),
    BusinessTypeProfile(
        code: 'boutique', label: 'Boutique', capabilities: apparel),
    BusinessTypeProfile(
        code: 'tienda_ropa', label: 'Tienda de ropa', capabilities: apparel),
    BusinessTypeProfile(code: 'tienda_general', label: 'Tienda general'),
    BusinessTypeProfile(
        code: 'tienda_tecnologia',
        label: 'Tienda de tecnología',
        capabilities: technology),
    BusinessTypeProfile(
        code: 'tienda_celulares',
        label: 'Tienda de celulares',
        capabilities: technology),
    BusinessTypeProfile(
        code: 'electrodomesticos',
        label: 'Tienda de electrodomésticos',
        capabilities: technology),
    BusinessTypeProfile(
        code: 'accesorios',
        label: 'Tienda de accesorios',
        capabilities: {BusinessCapability.variants}),
    BusinessTypeProfile(code: 'repuestos', label: 'Repuestos', capabilities: {
      BusinessCapability.serialTracking,
      BusinessCapability.warranty
    }),
    BusinessTypeProfile(
        code: 'taller', label: 'Taller', capabilities: workshop),
    BusinessTypeProfile(
        code: 'salon_belleza',
        label: 'Salón de belleza',
        capabilities: personalCare),
    BusinessTypeProfile(
        code: 'barberia', label: 'Barbería', capabilities: personalCare),
    BusinessTypeProfile(code: 'spa', label: 'Spa', capabilities: personalCare),
    BusinessTypeProfile(
      code: 'veterinaria',
      label: 'Veterinaria',
      capabilities: {
        BusinessCapability.pets,
        BusinessCapability.services,
        BusinessCapability.appointments,
        BusinessCapability.expiration,
        BusinessCapability.batches,
        BusinessCapability.expirationAlerts,
      },
    ),
    BusinessTypeProfile(code: 'pet_shop', label: 'Pet Shop', capabilities: {
      BusinessCapability.pets,
      BusinessCapability.expiration,
      BusinessCapability.expirationAlerts
    }),
    BusinessTypeProfile(code: 'libreria', label: 'Librería'),
    BusinessTypeProfile(code: 'papeleria', label: 'Papelería'),
    BusinessTypeProfile(code: 'licoreria', label: 'Licorería', capabilities: {
      BusinessCapability.expiration,
      BusinessCapability.wholesalePrices
    }),
    BusinessTypeProfile(code: 'joyeria', label: 'Joyería', capabilities: {
      BusinessCapability.serialTracking,
      BusinessCapability.variants
    }),
    BusinessTypeProfile(code: 'muebleria', label: 'Mueblería', capabilities: {
      BusinessCapability.variants,
      BusinessCapability.delivery,
      BusinessCapability.warranty
    }),
    BusinessTypeProfile(
        code: 'calzados', label: 'Tienda de calzados', capabilities: apparel),
    BusinessTypeProfile(code: 'perfumeria', label: 'Perfumería', capabilities: {
      BusinessCapability.expiration,
      BusinessCapability.batches,
      BusinessCapability.expirationAlerts
    }),
    BusinessTypeProfile(
        code: 'distribuidora',
        label: 'Distribuidora',
        capabilities: {
          BusinessCapability.wholesalePrices,
          BusinessCapability.batches,
          BusinessCapability.expiration,
          BusinessCapability.expirationAlerts,
          BusinessCapability.delivery
        }),
    BusinessTypeProfile(code: 'almacen', label: 'Almacén', capabilities: {
      BusinessCapability.wholesalePrices,
      BusinessCapability.batches
    }),
    BusinessTypeProfile(code: 'mayorista', label: 'Mayorista', capabilities: {
      BusinessCapability.wholesalePrices,
      BusinessCapability.batches,
      BusinessCapability.delivery
    }),
    BusinessTypeProfile(code: 'carniceria', label: 'Carnicería', capabilities: {
      BusinessCapability.weightedProducts,
      BusinessCapability.expiration,
      BusinessCapability.batches,
      BusinessCapability.fefo
    }),
    BusinessTypeProfile(code: 'fruteria', label: 'Frutería', capabilities: {
      BusinessCapability.weightedProducts,
      BusinessCapability.expiration
    }),
    BusinessTypeProfile(
        code: 'heladeria', label: 'Heladería', capabilities: foodService),
    BusinessTypeProfile(
        code: 'comida_rapida',
        label: 'Comida rápida',
        capabilities: foodService),
    BusinessTypeProfile(code: 'food_truck', label: 'Food Truck', capabilities: {
      BusinessCapability.kitchen,
      BusinessCapability.modifiers,
      BusinessCapability.combos,
      BusinessCapability.orderModes,
      BusinessCapability.delivery
    }),
    BusinessTypeProfile(
        code: 'servicios_profesionales',
        label: 'Servicios profesionales',
        capabilities: {
          BusinessCapability.services,
          BusinessCapability.appointments,
          BusinessCapability.estimates
        }),
    BusinessTypeProfile(
        code: 'centro_impresion',
        label: 'Centro de impresión',
        capabilities: {
          BusinessCapability.services,
          BusinessCapability.workOrders,
          BusinessCapability.estimates
        }),
    BusinessTypeProfile(
        code: 'tienda_informatica',
        label: 'Tienda de informática',
        capabilities: technology),
    BusinessTypeProfile(code: 'otro', label: 'Negocio genérico / Otros'),
  ];

  static BusinessTypeProfile byValue(String? value) {
    final normalized = _normalize(value ?? '');
    for (final profile in profiles) {
      if (_normalize(profile.code) == normalized ||
          _normalize(profile.label) == normalized) {
        return profile;
      }
    }
    const aliases = {
      'ropa y calzado': 'tienda_ropa',
      'salon / barberia': 'salon_belleza',
      'otro': 'otro',
    };
    final alias = aliases[normalized];
    return profiles.firstWhere(
      (profile) => profile.code == alias,
      orElse: () => profiles.last,
    );
  }

  static Set<String> recommendedCodes(String? businessType) =>
      byValue(businessType).capabilities.map((item) => item.code).toSet();

  static String _normalize(String value) => value
      .trim()
      .toLowerCase()
      .replaceAll('á', 'a')
      .replaceAll('é', 'e')
      .replaceAll('í', 'i')
      .replaceAll('ó', 'o')
      .replaceAll('ú', 'u')
      .replaceAll('ü', 'u')
      .replaceAll('ñ', 'n');
}
