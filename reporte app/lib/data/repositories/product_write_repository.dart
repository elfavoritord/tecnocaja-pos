import 'dart:async';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_storage/firebase_storage.dart';

import '../models/inventory_model.dart';
import '../models/user_model.dart';

class ProductWriteInput {
  final String? docId;
  final String name;
  final String barcode;
  final String category;
  final String brand;
  final String unit;
  final double cost;
  final double price;
  final int stock;
  final int minStock;
  final bool appliesTax;
  final bool isActive;
  final String? branchId;
  final Uint8List? imageBytes;
  final String? currentImageUrl;
  final bool allowNoBarcode;

  const ProductWriteInput({
    this.docId,
    required this.name,
    required this.barcode,
    required this.category,
    required this.brand,
    required this.unit,
    required this.cost,
    required this.price,
    required this.stock,
    required this.minStock,
    required this.appliesTax,
    required this.isActive,
    this.branchId,
    this.imageBytes,
    this.currentImageUrl,
    this.allowNoBarcode = false,
  });
}

class ProductCategoryOption {
  final String id;
  final String name;

  const ProductCategoryOption({required this.id, required this.name});

  factory ProductCategoryOption.fromFirestore(DocumentSnapshot doc) {
    final data = (doc.data() as Map<String, dynamic>?) ?? {};
    return ProductCategoryOption(
      id: doc.id,
      name: (data['name'] ?? data['nombre'] ?? '').toString().trim(),
    );
  }
}

class ProductDuplicateCandidate {
  final ProductModel product;
  final bool sameBarcode;
  final bool sameName;
  final bool similarName;

  const ProductDuplicateCandidate({
    required this.product,
    this.sameBarcode = false,
    this.sameName = false,
    this.similarName = false,
  });
}

class ProductWriteRepository {
  ProductWriteRepository({
    FirebaseFirestore? firestore,
    FirebaseStorage? storage,
  }) : _firestore = firestore ?? FirebaseFirestore.instance,
       _storage = storage;

  final FirebaseFirestore _firestore;
  final FirebaseStorage? _storage;

  static const _cloudTimeout = Duration(seconds: 25);

  Future<void> saveProduct({
    required String businessId,
    required UserModel user,
    required ProductWriteInput input,
  }) async {
    if (user.role != UserRole.admin && user.role != UserRole.branchAdmin) {
      throw Exception(
        'Solo administradores pueden agregar o editar productos.',
      );
    }

    final name = input.name.trim();
    final barcode = input.barcode.trim();
    final category = input.category.trim();
    final code = barcode.isNotEmpty
        ? barcode
        : 'SIN-CODIGO-${DateTime.now().millisecondsSinceEpoch}';

    if (name.isEmpty) {
      throw Exception('El nombre del producto es obligatorio.');
    }
    if (barcode.isEmpty && !input.allowNoBarcode) {
      throw Exception('Debes colocar el código de barra.');
    }
    if (category.isEmpty) {
      throw Exception('Selecciona una categoría sincronizada desde el POS.');
    }
    if (input.price <= 0) {
      throw Exception('El precio debe ser mayor que cero.');
    }
    if (input.cost < 0) {
      throw Exception('El costo no puede ser negativo.');
    }
    if (input.stock < 0) {
      throw Exception('El stock inicial no puede ser negativo.');
    }
    if (input.minStock < 0) {
      throw Exception('El stock mínimo no puede ser negativo.');
    }

    final products = _firestore
        .collection('businesses')
        .doc(businessId)
        .collection('products');
    final categories = _firestore
        .collection('businesses')
        .doc(businessId)
        .collection('categories');

    final docRef = input.docId == null || input.docId!.trim().isEmpty
        ? products.doc(_buildProductDocId(code, name))
        : products.doc(input.docId);

    await _assertCategoryExists(categories: categories, category: category);

    if (barcode.isNotEmpty) {
      await _assertUnique(
        products: products,
        field: 'barcode',
        value: barcode,
        currentDocId: docRef.id,
        label: 'código de barra',
      );
      await _assertUnique(
        products: products,
        field: 'codigo',
        value: barcode,
        currentDocId: docRef.id,
        label: 'código de barra',
      );
    }

    String? imageUrl = input.currentImageUrl;
    if (input.imageBytes != null) {
      imageUrl = await _uploadImage(
        businessId: businessId,
        docId: docRef.id,
        imageBytes: input.imageBytes!,
      );
    }

    final now = FieldValue.serverTimestamp();
    final data = <String, dynamic>{
      'branchId': input.branchId,
      'name': name,
      'nombre': name,
      'sku': code,
      'codigo': code,
      'barcode': barcode,
      'allowNoBarcode': input.allowNoBarcode,
      'category': category,
      'categoria': category,
      'brand': input.brand.trim(),
      'marca': input.brand.trim(),
      'unit': input.unit,
      'unidad': input.unit,
      'cost': input.cost,
      'precioCompra': input.cost,
      'price': input.price,
      'precioVenta': input.price,
      'stock': input.stock,
      'minStock': input.minStock,
      'stockMin': input.minStock,
      'appliesTax': input.appliesTax,
      'aplicaItbis': input.appliesTax,
      'isActive': input.isActive,
      'estado': input.isActive ? 'Activo' : 'Inactivo',
      'imageUrl': imageUrl,
      'origin': 'app_reporte',
      'origen': 'app_reporte',
      'synced': false,
      'sincronizado': false,
      'syncStatus': 'pending',
      'syncError': null,
      'syncAttempts': 0,
      'updatedBy': user.id,
      'updatedByName': user.displayName,
      'fechaActualizacion': now,
      'updatedAt': now,
    };

    if (input.docId == null || input.docId!.trim().isEmpty) {
      data['businessId'] = businessId;
      data['createdBy'] = user.id;
      data['creadoPor'] = user.displayName;
      data['createdByName'] = user.displayName;
      data['fechaCreacion'] = now;
      data['createdAt'] = now;
    }

    await _guardCloudCall(
      docRef.set(data, SetOptions(merge: true)),
      'guardar el producto en la nube',
    );
  }

  Stream<List<ProductCategoryOption>> watchCategories(String businessId) {
    return _firestore
        .collection('businesses')
        .doc(businessId)
        .collection('categories')
        .orderBy('name')
        .snapshots()
        .map((snapshot) {
          final seen = <String>{};
          final list = <ProductCategoryOption>[];
          for (final doc in snapshot.docs) {
            final category = ProductCategoryOption.fromFirestore(doc);
            if (category.name.isEmpty) continue;
            final key = _normalizeDuplicateText(category.name);
            if (!seen.add(key)) continue;
            list.add(category);
          }
          return list;
        });
  }

  Future<List<ProductDuplicateCandidate>> findDuplicateCandidates({
    required String businessId,
    required String name,
    required String barcode,
    required String category,
    required String brand,
    String? currentDocId,
  }) async {
    final products = _firestore
        .collection('businesses')
        .doc(businessId)
        .collection('products');
    final candidates = <String, ProductDuplicateCandidate>{};

    Future<void> addQuery(
      Query<Map<String, dynamic>> query, {
      bool sameBarcode = false,
      bool sameName = false,
    }) async {
      final snapshot = await _guardCloudCall(
        query.limit(8).get(),
        'validar productos duplicados',
      );
      for (final doc in snapshot.docs) {
        if (doc.id == currentDocId) continue;
        final product = ProductModel.fromFirestore(doc);
        candidates[doc.id] = ProductDuplicateCandidate(
          product: product,
          sameBarcode: sameBarcode,
          sameName: sameName,
        );
      }
    }

    final cleanBarcode = barcode.trim();
    if (cleanBarcode.isNotEmpty) {
      await addQuery(
        products.where('barcode', isEqualTo: cleanBarcode),
        sameBarcode: true,
      );
      await addQuery(
        products.where('codigo', isEqualTo: cleanBarcode),
        sameBarcode: true,
      );
    }

    final cleanName = name.trim();
    if (cleanName.isNotEmpty) {
      await addQuery(
        products.where('name', isEqualTo: cleanName),
        sameName: true,
      );
      await addQuery(
        products.where('nombre', isEqualTo: cleanName),
        sameName: true,
      );
    }

    final allSnapshot = await _guardCloudCall(
      products.orderBy('name').limit(250).get(),
      'buscar productos parecidos',
    );
    final targetName = _normalizeDuplicateText(name);
    final targetBrand = _normalizeDuplicateText(brand);
    final targetCategory = _normalizeDuplicateText(category);

    for (final doc in allSnapshot.docs) {
      if (doc.id == currentDocId || candidates.containsKey(doc.id)) continue;
      final product = ProductModel.fromFirestore(doc);
      final productName = _normalizeDuplicateText(product.name);
      final productBrand = _normalizeDuplicateText(product.brand);
      final productCategory = _normalizeDuplicateText(product.category);
      if (targetName.isEmpty || productName.isEmpty) continue;

      final sameCompactName =
          productName == targetName ||
          productName.contains(targetName) ||
          targetName.contains(productName);
      final sameContext =
          targetCategory.isEmpty ||
          productCategory.isEmpty ||
          productCategory == targetCategory ||
          (targetBrand.isNotEmpty &&
              productBrand.isNotEmpty &&
              productBrand == targetBrand);

      if (sameCompactName && sameContext) {
        candidates[doc.id] = ProductDuplicateCandidate(
          product: product,
          similarName: true,
        );
      }
    }

    return candidates.values.toList();
  }

  Future<void> _assertUnique({
    required CollectionReference<Map<String, dynamic>> products,
    required String field,
    required String value,
    required String currentDocId,
    required String label,
  }) async {
    if (value.trim().isEmpty) return;
    final snapshot = await _guardCloudCall(
      products.where(field, isEqualTo: value.trim()).limit(2).get(),
      'validar duplicados',
    );
    for (final doc in snapshot.docs) {
      if (doc.id != currentDocId) {
        throw Exception('Ya existe un producto con ese $label.');
      }
    }
  }

  Future<void> _assertCategoryExists({
    required CollectionReference<Map<String, dynamic>> categories,
    required String category,
  }) async {
    final snapshot = await _guardCloudCall(
      categories.where('name', isEqualTo: category).limit(1).get(),
      'validar la categoría del POS',
    );
    if (snapshot.docs.isNotEmpty) return;

    final legacySnapshot = await _guardCloudCall(
      categories.where('nombre', isEqualTo: category).limit(1).get(),
      'validar la categoría del POS',
    );
    if (legacySnapshot.docs.isNotEmpty) return;
    throw Exception('La categoría seleccionada no existe en Tecno Caja POS.');
  }

  Future<String> _uploadImage({
    required String businessId,
    required String docId,
    required Uint8List imageBytes,
  }) async {
    final ref = (_storage ?? FirebaseStorage.instance)
        .ref()
        .child('businesses')
        .child(businessId)
        .child('products')
        .child('$docId.jpg');
    await _guardCloudCall(
      ref.putData(imageBytes, SettableMetadata(contentType: 'image/jpeg')),
      'subir la imagen del producto',
    );
    return _guardCloudCall(
      ref.getDownloadURL(),
      'obtener la imagen del producto',
    );
  }

  Future<T> _guardCloudCall<T>(Future<T> future, String action) async {
    try {
      return await future.timeout(_cloudTimeout);
    } on FirebaseException catch (error) {
      throw Exception(_friendlyFirebaseError(error, action));
    } on TimeoutException {
      throw Exception(
        'No se pudo $action porque la nube tardó demasiado. Revisa internet y vuelve a intentar.',
      );
    }
  }

  String _friendlyFirebaseError(FirebaseException error, String action) {
    switch (error.code) {
      case 'permission-denied':
        return 'No tienes permiso para $action. Revisa las reglas o el rol administrador.';
      case 'unavailable':
      case 'deadline-exceeded':
        return 'No se pudo $action porque Firebase no respondió. Revisa internet.';
      case 'unauthenticated':
        return 'La sesión venció. Cierra sesión y vuelve a entrar.';
      default:
        return 'No se pudo $action: ${error.message ?? error.code}.';
    }
  }

  String _buildProductDocId(String code, String name) {
    final raw = code.trim().isNotEmpty ? code : name;
    final slug = raw
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
        .replaceAll(RegExp(r'-+'), '-')
        .replaceAll(RegExp(r'^-|-$'), '');
    final suffix = DateTime.now().millisecondsSinceEpoch.toString();
    return 'app-${slug.isEmpty ? 'producto' : slug}-$suffix';
  }

  static String _normalizeDuplicateText(String value) {
    var text = value.trim().toLowerCase();
    const replacements = {
      'á': 'a',
      'é': 'e',
      'í': 'i',
      'ó': 'o',
      'ú': 'u',
      'ü': 'u',
      'ñ': 'n',
    };
    replacements.forEach((from, to) {
      text = text.replaceAll(from, to);
    });
    return text.replaceAll(RegExp(r'[^a-z0-9]+'), '');
  }
}
