import '../business/business_capabilities.dart';

/// Listas de referencia para formularios (registro de negocio, clientes).
class Dominicana {
  const Dominicana._();

  static const List<String> provincias = [
    'Distrito Nacional',
    'Azua',
    'Bahoruco',
    'Barahona',
    'Dajabón',
    'Duarte',
    'Elías Piña',
    'El Seibo',
    'Espaillat',
    'Hato Mayor',
    'Hermanas Mirabal',
    'Independencia',
    'La Altagracia',
    'La Romana',
    'La Vega',
    'María Trinidad Sánchez',
    'Monseñor Nouel',
    'Monte Cristi',
    'Monte Plata',
    'Pedernales',
    'Peravia',
    'Puerto Plata',
    'Samaná',
    'San Cristóbal',
    'San José de Ocoa',
    'San Juan',
    'San Pedro de Macorís',
    'Sánchez Ramírez',
    'Santiago',
    'Santiago Rodríguez',
    'Santo Domingo',
    'Valverde',
  ];

  static final List<String> tiposDeNegocio = List.unmodifiable(
    BusinessCatalog.profiles.map((profile) => profile.label),
  );

  static const List<String> monedas = ['DOP', 'USD'];
}
