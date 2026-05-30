import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

Future<String> savePdfFile(Uint8List bytes, String fileName) async {
  Directory? targetDirectory;

  try {
    targetDirectory = await getDownloadsDirectory();
  } catch (_) {
    targetDirectory = null;
  }

  targetDirectory ??= await getApplicationDocumentsDirectory();

  final safeName = fileName.replaceAll(RegExp(r'[<>:"/\\|?*]'), '_');
  final file = File(
    '${targetDirectory.path}${Platform.pathSeparator}$safeName',
  );

  await file.parent.create(recursive: true);
  await file.writeAsBytes(bytes, flush: true);
  return file.path;
}
