import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/utils/app_date_utils.dart';
import '../../../data/models/agenda_model.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/documentos_provider.dart';

class DocumentosScreen extends ConsumerWidget {
  final String? clienteId;
  final String? clienteNombre;

  const DocumentosScreen({super.key, this.clienteId, this.clienteNombre});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final docsAsync = ref.watch(documentosProvider(clienteId));
    final uploadState = ref.watch(documentoUploadProvider);
    final categoria = ref.watch(documentosCategoriaProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(clienteNombre != null ? 'Documentos — $clienteNombre' : 'Documentos'),
        actions: [
          IconButton(
            icon: Badge(isLabelVisible: categoria != null, child: const Icon(Icons.filter_list_rounded)),
            onPressed: () => _showCategoriaFilter(context, ref, categoria),
          ),
        ],
      ),
      body: Column(
        children: [
          if (uploadState.isUploading)
            LinearProgressIndicator(value: uploadState.progress, backgroundColor: AppColors.lightBorder, color: AppColors.primary),
          Expanded(
            child: docsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text(e.toString(), style: const TextStyle(color: AppColors.error))),
              data: (docs) {
                final filtered = categoria != null ? docs.where((d) => d.categoria == categoria).toList() : docs;
                if (filtered.isEmpty) {
                  return _EmptyView(onUpload: () => _pickAndUpload(context, ref));
                }
                return ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: filtered.length,
                  itemBuilder: (_, i) => _DocumentoTile(
                    doc: filtered[i],
                    onDelete: () => _confirmDelete(context, ref, filtered[i]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: uploadState.isUploading ? null : () => _pickAndUpload(context, ref),
        icon: const Icon(Icons.upload_file_rounded),
        label: const Text('Subir documento'),
      ),
    );
  }

  Future<void> _pickAndUpload(BuildContext context, WidgetRef ref) async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.any,
      allowMultiple: false,
    );
    if (result == null || result.files.isEmpty) return;

    final pf = result.files.first;
    if (pf.path == null) return;

    final file = File(pf.path!);
    if (!context.mounted) return;

    await ref.read(documentoUploadProvider.notifier).upload(
          file: file,
          nombre: pf.name,
          clienteId: clienteId,
          clienteNombre: clienteNombre,
        );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref, DocumentoModel doc) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Eliminar documento'),
        content: Text('¿Eliminar "${doc.nombre}"? Esta acción no se puede deshacer.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancelar')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.error),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Eliminar'),
          ),
        ],
      ),
    );
    if (confirm == true) {
      final profile = ref.read(userProfileProvider).valueOrNull;
      if (profile != null) {
        await ref.read(documentoUploadProvider.notifier).delete(profile.contadorDocId, doc.id, doc.storageRef);
      }
    }
  }

  void _showCategoriaFilter(BuildContext context, WidgetRef ref, String? current) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (_) => Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Filtrar por categoría', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: DocumentoModel.categorias.map((cat) => FilterChip(
                label: Text(_catLabel(cat)),
                selected: current == cat,
                onSelected: (_) {
                  ref.read(documentosCategoriaProvider.notifier).state = current == cat ? null : cat;
                  Navigator.pop(context);
                },
              )).toList(),
            ),
            if (current != null) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () { ref.read(documentosCategoriaProvider.notifier).state = null; Navigator.pop(context); },
                  child: const Text('Limpiar filtro'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _catLabel(String cat) {
    switch (cat) {
      case 'declaraciones': return 'Declaraciones';
      case 'contratos': return 'Contratos';
      case 'estados_financieros': return 'Estados financieros';
      case 'facturas': return 'Facturas';
      default: return 'Otros';
    }
  }
}

class _DocumentoTile extends StatelessWidget {
  final DocumentoModel doc;
  final VoidCallback onDelete;

  const _DocumentoTile({required this.doc, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Container(
          width: 44, height: 44,
          decoration: BoxDecoration(
            color: _tipoColor.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(10),
          ),
          alignment: Alignment.center,
          child: Icon(_tipoIcon, color: _tipoColor, size: 22),
        ),
        title: Text(doc.nombre, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (doc.clienteNombre != null)
              Text(doc.clienteNombre!, style: const TextStyle(fontSize: 11)),
            Text('${doc.tamanoLabel} · ${AppDateUtils.formatFecha(doc.createdAt)}', style: const TextStyle(fontSize: 11, color: AppColors.textTertiary)),
          ],
        ),
        isThreeLine: doc.clienteNombre != null,
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(icon: const Icon(Icons.open_in_new_rounded, size: 20), onPressed: () => _open(doc.url), tooltip: 'Abrir'),
            IconButton(icon: const Icon(Icons.delete_outline, size: 20, color: AppColors.error), onPressed: onDelete, tooltip: 'Eliminar'),
          ],
        ),
        onTap: () => _open(doc.url),
      ),
    );
  }

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri != null && await canLaunchUrl(uri)) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  IconData get _tipoIcon {
    if (doc.esPdf) return Icons.picture_as_pdf_rounded;
    if (doc.esImagen) return Icons.image_rounded;
    if (doc.esExcel) return Icons.table_chart_rounded;
    if (doc.esWord) return Icons.description_rounded;
    if (doc.esXml) return Icons.code_rounded;
    return Icons.insert_drive_file_rounded;
  }

  Color get _tipoColor {
    if (doc.esPdf) return AppColors.error;
    if (doc.esImagen) return AppColors.info;
    if (doc.esExcel) return AppColors.success;
    if (doc.esWord) return AppColors.primary;
    return AppColors.textSecondary;
  }
}

class _EmptyView extends StatelessWidget {
  final VoidCallback onUpload;
  const _EmptyView({required this.onUpload});

  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.folder_open_outlined, size: 64, color: AppColors.textTertiary),
            const SizedBox(height: 16),
            const Text('No hay documentos', style: TextStyle(color: AppColors.textSecondary, fontSize: 15)),
            const SizedBox(height: 16),
            FilledButton.icon(onPressed: onUpload, icon: const Icon(Icons.upload_file_rounded), label: const Text('Subir documento')),
          ],
        ),
      );
}
