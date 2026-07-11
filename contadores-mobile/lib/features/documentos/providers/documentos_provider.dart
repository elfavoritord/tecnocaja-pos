import 'dart:io';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';
import '../../../data/models/agenda_model.dart';
import '../../../data/services/agenda_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../../agenda/providers/agenda_provider.dart';

final documentosProvider = StreamProvider.family<List<DocumentoModel>, String?>((ref, clienteId) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  if (profile == null) return const Stream.empty();
  return ref.read(agendaServiceProvider).watchDocumentos(profile.contadorDocId, clienteId: clienteId);
});

final documentosCategoriaProvider = StateProvider<String?>((ref) => null);

class DocumentoUploadState {
  final bool isUploading;
  final double progress;
  final String? error;

  const DocumentoUploadState({this.isUploading = false, this.progress = 0, this.error});

  DocumentoUploadState copyWith({bool? isUploading, double? progress, String? error, bool clearError = false}) =>
      DocumentoUploadState(
        isUploading: isUploading ?? this.isUploading,
        progress: progress ?? this.progress,
        error: clearError ? null : (error ?? this.error),
      );
}

class DocumentoUploadNotifier extends StateNotifier<DocumentoUploadState> {
  final AgendaService _agendaService;
  final FirebaseStorage _storage;
  final String _contadorDocId;
  final String _uid;

  DocumentoUploadNotifier(this._agendaService, this._storage, this._contadorDocId, this._uid)
      : super(const DocumentoUploadState());

  Future<DocumentoModel?> upload({
    required File file,
    required String nombre,
    String? clienteId,
    String? clienteNombre,
    String? descripcion,
    String? categoria,
  }) async {
    state = state.copyWith(isUploading: true, progress: 0, clearError: true);
    try {
      final ext = p.extension(file.path);
      final fileName = '${const Uuid().v4()}$ext';
      final ref = _storage.ref('contadores/$_contadorDocId/documentos/$fileName');

      final task = ref.putFile(file);
      task.snapshotEvents.listen((snap) {
        final pct = snap.bytesTransferred / (snap.totalBytes == 0 ? 1 : snap.totalBytes);
        state = state.copyWith(progress: pct);
      });

      final snap = await task;
      final url = await snap.ref.getDownloadURL();
      final bytes = (await file.length());

      final doc = DocumentoModel(
        id: '',
        contadorId: _contadorDocId,
        clienteId: clienteId,
        clienteNombre: clienteNombre,
        nombre: nombre.isEmpty ? p.basename(file.path) : nombre,
        tipo: ext.replaceAll('.', '').toLowerCase(),
        url: url,
        storageRef: ref.fullPath,
        tamanoBytes: bytes,
        descripcion: descripcion,
        categoria: categoria,
        uploadedBy: _uid,
      );

      final saved = await _agendaService.saveDocumento(_contadorDocId, doc);
      state = state.copyWith(isUploading: false, progress: 1);
      return saved;
    } catch (e) {
      state = state.copyWith(isUploading: false, error: e.toString());
      return null;
    }
  }

  Future<bool> delete(String contadorDocId, String docId, String? storageRef) async {
    try {
      if (storageRef != null) {
        await _storage.ref(storageRef).delete();
      }
      await _agendaService.deleteDocumento(contadorDocId, docId);
      return true;
    } catch (_) {
      return false;
    }
  }
}

final documentoUploadProvider = StateNotifierProvider.autoDispose<DocumentoUploadNotifier, DocumentoUploadState>((ref) {
  final profile = ref.watch(userProfileProvider).valueOrNull;
  return DocumentoUploadNotifier(
    ref.read(agendaServiceProvider),
    FirebaseStorage.instance,
    profile?.contadorDocId ?? '',
    profile?.uid ?? '',
  );
});
