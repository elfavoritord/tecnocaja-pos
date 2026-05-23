const businessConfig = {
  default: {
    modules: ['ventas', 'productos', 'inventario', 'clientes', 'proveedores', 'caja', 'colacobro', 'posmovil', 'reportes', 'movimientos', 'usuarios', 'configuracion', 'delivery'],
    productFields: [],
    features: ['inventario', 'reportes', 'clientes', 'proveedores'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery' },
        { value: 'recoger', label: 'Para recoger' },
        { value: 'mesa', label: 'Mesa' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'en preparacion', label: 'En preparación' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      paymentMethods: ['efectivo', 'tarjeta', 'transferencia', 'credito', 'contra_entrega'],
      showTableField: true,
      showDeliveryFields: true,
      showKitchenStatus: true,
      notesPlaceholder: 'Observaciones internas del pedido',
      tableLabel: 'Mesa / Referencia',
      deliveryUserLabel: 'Responsable',
      deliveryPhoneLabel: 'Teléfono del cliente',
      deliveryAddressLabel: 'Dirección de entrega',
      deliveryReferenceLabel: 'Referencia',
      deliveryLinkLabel: 'Link de ubicación',
      advancedSummary: 'Personaliza el pedido según el flujo del negocio.'
    },
    dashboard: {
      reportCards: {
        salesTitle: 'Total Ventas',
        salesSubtitle: 'Resumen del periodo',
        profitTitle: 'Ganancias',
        profitSubtitle: 'Después de costos',
        topTitle: 'Producto Más Vendido',
        topSubtitle: '0 unidades',
        taxTitle: 'ITBIS Recaudado',
        taxSubtitle: 'Impuesto aplicado'
      },
      trendTitle: 'Tendencia de ventas',
      trendSubtitle: 'Comportamiento del periodo seleccionado.',
      paymentTitle: 'Métodos de pago',
      paymentSubtitle: 'Participación por canal de cobro.',
      orderTypeTitle: 'Tipos de pedido',
      orderTypeSubtitle: 'Mostrador, delivery, recoger o mesa.'
    }
  },
  pizzeria: {
    productFields: [
      { key: 'tamanoBase', label: 'Tamaño base', type: 'select', options: ['Personal', 'Mediana', 'Familiar'], highlight: true },
      { key: 'mitadMitad', label: 'Mitad y mitad', type: 'boolean', highlight: true },
      { key: 'ingredientesExtra', label: 'Ingredientes extra sugeridos', type: 'tags', placeholder: 'Pepperoni, queso extra, bacon', highlight: true },
      { key: 'canalCocina', label: 'Canal de cocina', type: 'select', options: ['Horno', 'Preparación fría', 'Mostrador'] }
    ],
    features: ['pizzas_por_tamano', 'ingredientes_extra', 'mitad_mitad', 'ordenes_por_mesa', 'delivery', 'cocina'],
    salesFlow: {
      kitchenStatuses: [
        { value: 'preparando', label: 'Preparando' },
        { value: 'horneando', label: 'Horneando' },
        { value: 'enviado', label: 'Enviado' },
        { value: 'entregado', label: 'Entregado' }
      ],
      notesPlaceholder: 'Mitad pepperoni, borde de queso, llamar al llegar',
      tableLabel: 'Mesa / Barra / Orden',
      deliveryUserLabel: 'Delivery asignado',
      advancedSummary: 'Combina salón, delivery y cocina con estados de preparación.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Pizza / Combo Top',
        topSubtitle: 'Sabor más vendido'
      },
      orderTypeTitle: 'Canales del pedido',
      orderTypeSubtitle: 'Mostrador, delivery, recoger o mesa.'
    }
  },
  colmado: {
    productFields: [
      { key: 'presentacion', label: 'Presentación', type: 'select', options: ['Unidad', 'Paquete', 'Libra', 'Caja'], highlight: true },
      { key: 'permiteFiado', label: 'Permite fiado', type: 'boolean', highlight: true },
      { key: 'esRecarga', label: 'Producto o servicio de recarga', type: 'boolean' },
      { key: 'comboBarrial', label: 'Promoción / combo', type: 'tags', placeholder: '2x1, combo colmado', highlight: true }
    ],
    features: ['scanner_rapido', 'venta_por_unidad', 'fiado_simple', 'recargas', 'delivery_barrial', 'promociones'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery barrial' },
        { value: 'recoger', label: 'Para recoger' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'despachando', label: 'Despachando' },
        { value: 'entregado', label: 'Entregado' }
      ],
      notesPlaceholder: 'Separar funda, incluir recarga o crédito simple',
      tableLabel: 'Referencia del pedido',
      advancedSummary: 'Ideal para mostrador rápido, delivery barrial y fiado simple.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Artículo Más Vendido',
        topSubtitle: 'Movimiento por góndola'
      },
      paymentTitle: 'Canales de cobro',
      orderTypeTitle: 'Despacho del colmado'
    }
  },
  restaurante: {
    productFields: [
      { key: 'estacion', label: 'Estación', type: 'select', options: ['Cocina', 'Bar', 'Postres'], highlight: true },
      { key: 'comanda', label: 'Usa comanda', type: 'boolean', highlight: true },
      { key: 'propinaSugerida', label: 'Propina sugerida (%)', type: 'number' },
      { key: 'acompanantes', label: 'Acompañantes', type: 'tags', placeholder: 'Papas, ensalada, pan', highlight: true }
    ],
    features: ['mesas', 'comandas', 'cocina_bar', 'dividir_cuenta', 'propina'],
    salesFlow: {
      orderTypes: [
        { value: 'mesa', label: 'Mesa' },
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery' },
        { value: 'recoger', label: 'Para llevar' }
      ],
      kitchenStatuses: [
        { value: 'comanda', label: 'Comanda enviada' },
        { value: 'en cocina', label: 'En cocina' },
        { value: 'en bar', label: 'En bar' },
        { value: 'lista', label: 'Lista' },
        { value: 'servida', label: 'Servida' }
      ],
      notesPlaceholder: 'Mesa 8, dividir cuenta, sin cebolla, primero bebidas',
      tableLabel: 'Mesa / Salón',
      deliveryUserLabel: 'Mesero o delivery',
      advancedSummary: 'Controla consumo por mesa, cocina, bar y cierre de cuenta.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Plato Más Vendido',
        topSubtitle: 'Consumo del salón'
      },
      orderTypeTitle: 'Canales del restaurante',
      orderTypeSubtitle: 'Mesa, mostrador, delivery o para llevar.'
    }
  },
  farmacia: {
    productFields: [
      { key: 'lote', label: 'Lote', type: 'text', placeholder: 'Lote del suplidor', highlight: true },
      { key: 'fechaVencimiento', label: 'Fecha de vencimiento', type: 'date', highlight: true },
      { key: 'requiereReceta', label: 'Requiere receta', type: 'boolean', highlight: true },
      { key: 'nombreGenerico', label: 'Nombre genérico', type: 'text', placeholder: 'Paracetamol' },
      { key: 'sustitutos', label: 'Sustitutos', type: 'tags', placeholder: 'Marca A, Marca B' }
    ],
    features: ['lote_vencimiento', 'receta', 'busqueda_generico', 'alerta_vencimiento', 'sustitutos'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery' }
      ],
      kitchenStatuses: [
        { value: 'validando', label: 'Validando receta' },
        { value: 'preparando', label: 'Preparando pedido' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Validar receta, confirmar dosis o sustituto',
      tableLabel: 'Referencia sanitaria',
      deliveryUserLabel: 'Mensajero asignado',
      advancedSummary: 'Permite controlar receta, vencimiento y preparación del despacho.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Medicamento Más Vendido',
        topSubtitle: 'Movimiento farmacéutico'
      },
      taxTitle: 'Impuestos / cargos',
      orderTypeTitle: 'Despachos farmacéuticos'
    }
  },
  ferreteria: {
    productFields: [
      { key: 'medida', label: 'Medida', type: 'text', placeholder: '1/2, 3/4, 6 metros', highlight: true },
      { key: 'variantes', label: 'Variantes', type: 'tags', placeholder: 'Color, tamaño, pulgadas', highlight: true },
      { key: 'tipoVenta', label: 'Venta por', type: 'select', options: ['Unidad', 'Metro', 'Caja', 'Rollo'], highlight: true },
      { key: 'materialPesado', label: 'Material pesado', type: 'boolean' },
      { key: 'cotizable', label: 'Disponible para cotización', type: 'boolean' }
    ],
    features: ['venta_por_medida', 'variantes_tecnicas', 'cotizaciones', 'material_pesado'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Despacho' },
        { value: 'recoger', label: 'Retiro' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'preparando', label: 'Preparando materiales' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Cortar por medida, preparar despacho o cotización',
      tableLabel: 'Proyecto / Pedido',
      deliveryUserLabel: 'Despachador',
      advancedSummary: 'Útil para cotizaciones, materiales por medida y despachos pesados.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Artículo Técnico Top',
        topSubtitle: 'Rotación del mostrador'
      },
      orderTypeTitle: 'Canales de despacho'
    }
  },
  boutique: {
    productFields: [
      { key: 'tallas', label: 'Tallas', type: 'tags', placeholder: 'S, M, L, XL', highlight: true },
      { key: 'colores', label: 'Colores', type: 'tags', placeholder: 'Negro, Beige, Azul', highlight: true },
      { key: 'modelo', label: 'Modelo', type: 'text', placeholder: 'Ref. BTQ-2026', highlight: true },
      { key: 'temporada', label: 'Temporada', type: 'select', options: ['Primavera', 'Verano', 'Otoño', 'Invierno', 'Todo el año'] },
      { key: 'admiteCambios', label: 'Admite cambios o devoluciones', type: 'boolean' }
    ],
    features: ['variantes_talla_color', 'temporadas', 'cambios_devoluciones', 'control_por_variante'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Tienda' },
        { value: 'delivery', label: 'Delivery' },
        { value: 'recoger', label: 'Retiro' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'preparando', label: 'Preparando paquete' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Separar talla, reservar color o preparar cambio',
      tableLabel: 'Cliente / Reserva',
      advancedSummary: 'Pensado para variantes, temporadas y atención visual de tienda.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Prenda Más Vendida',
        topSubtitle: 'Rotación por colección'
      },
      orderTypeTitle: 'Canales de boutique'
    }
  },
  panaderia: {
    productFields: [
      { key: 'produccionDiaria', label: 'Producción diaria', type: 'boolean', highlight: true },
      { key: 'pedidoPersonalizado', label: 'Pedido personalizado', type: 'boolean', highlight: true },
      { key: 'fechaEntrega', label: 'Fecha de entrega', type: 'date' },
      { key: 'productoDelDia', label: 'Producto del día', type: 'boolean', highlight: true },
      { key: 'ingredientesBase', label: 'Ingredientes base', type: 'tags', placeholder: 'Harina, mantequilla, azúcar' }
    ],
    features: ['produccion_diaria', 'pedidos_personalizados', 'entregas', 'productos_del_dia'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'recoger', label: 'Retiro' },
        { value: 'delivery', label: 'Delivery' }
      ],
      kitchenStatuses: [
        { value: 'produccion', label: 'En producción' },
        { value: 'horneando', label: 'Horneando' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Bizcocho para mañana, sin azúcar, separar producto del día',
      tableLabel: 'Pedido / Encargo',
      advancedSummary: 'Controla producción diaria, encargos y fechas de entrega.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Producto del Día',
        topSubtitle: 'Rotación del horno'
      },
      orderTypeTitle: 'Despacho de panadería'
    }
  },
  tecnologia: {
    productFields: [
      { key: 'imeiSerial', label: 'IMEI / Serial', type: 'text', placeholder: 'IMEI o serial del equipo', highlight: true },
      { key: 'garantiaMeses', label: 'Garantía (meses)', type: 'number', highlight: true },
      { key: 'fichaTecnica', label: 'Ficha técnica', type: 'textarea', placeholder: 'RAM, almacenamiento, compatibilidad' },
      { key: 'requiereReparacion', label: 'Se usa en reparaciones', type: 'boolean' },
      { key: 'comboTecnico', label: 'Accesorios / combo', type: 'tags', placeholder: 'Cargador, case, mica', highlight: true }
    ],
    features: ['imei_serial', 'garantia', 'reparaciones', 'accesorios', 'ficha_tecnica', 'combos'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Envío' },
        { value: 'recoger', label: 'Retiro' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'revisando', label: 'Revisando equipo' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Registrar serial, garantía o accesorios incluidos',
      tableLabel: 'Orden / Servicio',
      advancedSummary: 'Ideal para seriales, garantías, accesorios y soporte técnico.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Equipo / Accesorio Top',
        topSubtitle: 'Salida por referencia'
      },
      orderTypeTitle: 'Canales de tecnología'
    }
  },
  salon: {
    productFields: [
      { key: 'requiereCita', label: 'Requiere cita', type: 'boolean', highlight: true },
      { key: 'estilista', label: 'Estilista sugerido', type: 'text', placeholder: 'Nombre del estilista', highlight: true },
      { key: 'tipoServicio', label: 'Tipo de servicio', type: 'select', options: ['Corte', 'Color', 'Spa', 'Tratamiento', 'Paquete'], highlight: true },
      { key: 'paquetePromo', label: 'Paquete / promoción', type: 'tags', placeholder: 'Corte + lavado, Spa dúo' },
      { key: 'historialCliente', label: 'Notas para historial', type: 'textarea', placeholder: 'Color usado, preferencias o alergias' }
    ],
    features: ['agenda_citas', 'servicios', 'estilistas', 'historial_cliente', 'paquetes_promociones'],
    salesFlow: {
      orderTypes: [
        { value: 'mesa', label: 'Cita / Silla' },
        { value: 'mostrador', label: 'Mostrador' }
      ],
      kitchenStatuses: [
        { value: 'agendada', label: 'Agendada' },
        { value: 'en servicio', label: 'En servicio' },
        { value: 'lista', label: 'Lista' },
        { value: 'cerrada', label: 'Cerrada' }
      ],
      showDeliveryFields: false,
      notesPlaceholder: 'Cita de coloración, estilista asignado, historial del cliente',
      tableLabel: 'Silla / Cabina / Cita',
      deliveryUserLabel: 'Estilista',
      advancedSummary: 'Gestiona citas, servicios, personal y notas del cliente.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Servicio Más Solicitado',
        topSubtitle: 'Actividad del salón'
      },
      orderTypeTitle: 'Atención por cita'
    }
  },
  cafeteria: {
    productFields: [
      { key: 'tamanoBebida', label: 'Tamaños', type: 'tags', placeholder: 'Pequeño, Mediano, Grande', highlight: true },
      { key: 'extrasCafe', label: 'Extras', type: 'tags', placeholder: 'Leche almendra, crema, topping', highlight: true },
      { key: 'comboCafe', label: 'Combos', type: 'tags', placeholder: 'Café + croissant', highlight: true },
      { key: 'paraLlevar', label: 'Disponible para llevar', type: 'boolean' }
    ],
    features: ['tamanos', 'extras', 'combos', 'para_llevar'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'recoger', label: 'Para llevar' },
        { value: 'mesa', label: 'Mesa' },
        { value: 'delivery', label: 'Delivery' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'en preparacion', label: 'Preparando bebida' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Grande, con extra shot, sin azúcar, para llevar',
      tableLabel: 'Mesa / Ticket',
      advancedSummary: 'Flujo pensado para bebidas rápidas, toppings y pedidos para llevar.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Bebida Top',
        topSubtitle: 'Rotación del mostrador'
      },
      orderTypeTitle: 'Canales de cafetería'
    }
  },
  licoreria: {
    productFields: [
      { key: 'formatoVenta', label: 'Formato de venta', type: 'select', options: ['Botella', 'Caja', 'Unidad'], highlight: true },
      { key: 'requiereEdad', label: 'Validación de edad', type: 'boolean', highlight: true },
      { key: 'comboBebidas', label: 'Combos de bebidas', type: 'tags', placeholder: 'Ron + hielo + refresco', highlight: true },
      { key: 'deliveryNocturno', label: 'Disponible para delivery nocturno', type: 'boolean' }
    ],
    features: ['botella_caja_unidad', 'promociones', 'validacion_edad', 'delivery_nocturno', 'combos'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery nocturno' },
        { value: 'recoger', label: 'Retiro' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'preparando', label: 'Preparando pedido' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Confirmar mayoría de edad, incluir hielo o combo',
      tableLabel: 'Pedido / Cliente',
      advancedSummary: 'Adapta el POS a botellas, cajas, combos y entregas nocturnas.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Bebida Más Vendida',
        topSubtitle: 'Salida por formato'
      },
      orderTypeTitle: 'Despacho licorero'
    }
  },
  repuestos: {
    productFields: [
      { key: 'compatibilidad', label: 'Compatibilidad', type: 'text', placeholder: 'Toyota Corolla 2014-2018', highlight: true },
      { key: 'marcaModeloAno', label: 'Marca / modelo / año', type: 'text', placeholder: 'Honda Civic 2017', highlight: true },
      { key: 'codigoOEM', label: 'Código OEM', type: 'text', placeholder: 'OEM-12345', highlight: true },
      { key: 'piezaTecnica', label: 'Ficha técnica', type: 'textarea', placeholder: 'Motor, suspensión, frenos...' },
      { key: 'aplicaInventarioTecnico', label: 'Inventario técnico', type: 'boolean' }
    ],
    features: ['compatibilidad_vehiculo', 'marca_modelo_ano', 'codigo_oem', 'busqueda_tecnica', 'inventario_tecnico'],
    salesFlow: {
      orderTypes: [
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Despacho' },
        { value: 'recoger', label: 'Retiro' }
      ],
      kitchenStatuses: [
        { value: 'pendiente', label: 'Pendiente' },
        { value: 'verificando', label: 'Verificando pieza' },
        { value: 'lista', label: 'Lista' },
        { value: 'entregada', label: 'Entregada' }
      ],
      notesPlaceholder: 'Validar OEM, compatibilidad o modelo exacto del vehículo',
      tableLabel: 'Vehículo / Orden',
      advancedSummary: 'Facilita búsqueda técnica y compatibilidad por vehículo.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Pieza Más Vendida',
        topSubtitle: 'Movimiento técnico'
      },
      orderTypeTitle: 'Despacho de repuestos'
    }
  },
  veterinaria: {
    productFields: [
      { key: 'especie', label: 'Especie', type: 'select', options: ['Perro', 'Gato', 'Ave', 'Conejo', 'Otro'], highlight: true },
      { key: 'raza', label: 'Raza', type: 'text', placeholder: 'Labrador, Persa, Mixto', highlight: true },
      { key: 'vacunas', label: 'Vacunas / controles', type: 'tags', placeholder: 'Rabia, Triple felina' },
      { key: 'historialMedico', label: 'Historial médico', type: 'textarea', placeholder: 'Observaciones clínicas o uso del producto' },
      { key: 'servicioConsulta', label: 'Servicio o consulta', type: 'boolean', highlight: true }
    ],
    features: ['ficha_mascota', 'especie_raza', 'vacunas', 'consultas', 'historial_medico', 'medicamentos_servicios'],
    salesFlow: {
      orderTypes: [
        { value: 'mesa', label: 'Consulta' },
        { value: 'mostrador', label: 'Mostrador' },
        { value: 'delivery', label: 'Delivery' }
      ],
      kitchenStatuses: [
        { value: 'agendada', label: 'Agendada' },
        { value: 'en consulta', label: 'En consulta' },
        { value: 'lista', label: 'Lista' },
        { value: 'cerrada', label: 'Cerrada' }
      ],
      notesPlaceholder: 'Mascota, vacuna, consulta o medicamento asociado',
      tableLabel: 'Mascota / Consulta',
      deliveryUserLabel: 'Veterinario / delivery',
      advancedSummary: 'Integra servicios, medicamentos y ficha básica de mascota.'
    },
    dashboard: {
      reportCards: {
        topTitle: 'Servicio / Producto Top',
        topSubtitle: 'Actividad veterinaria'
      },
      orderTypeTitle: 'Atención clínica'
    }
  }
};

function cloneConfigValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneConfigValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneConfigValue(item)]));
  }
  return value;
}

function mergeBusinessConfig(base, current) {
  const output = cloneConfigValue(base);
  Object.entries(current || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      output[key] = cloneConfigValue(value);
    } else if (value && typeof value === 'object') {
      output[key] = mergeBusinessConfig(output[key] || {}, value);
    } else {
      output[key] = value;
    }
  });
  return output;
}

function getBusinessConfig(type) {
  const key = String(type || 'default').trim().toLowerCase();
  const base = businessConfig.default || {};
  const current = businessConfig[key] || {};
  return mergeBusinessConfig(base, current);
}

window.businessConfig = businessConfig;
window.getBusinessConfig = getBusinessConfig;
