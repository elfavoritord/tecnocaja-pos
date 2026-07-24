import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Pantalla completa de escaneo. El anti-duplicado (una sola lectura por
/// apertura) se resuelve con una bandera local en vez de un debounce por
/// tiempo -- mas simple y sin riesgo de perder una lectura valida.
class BarcodeScannerSheet extends StatefulWidget {
  const BarcodeScannerSheet({super.key, this.vibrarActivo = true});

  final bool vibrarActivo;

  @override
  State<BarcodeScannerSheet> createState() => _BarcodeScannerSheetState();
}

class _BarcodeScannerSheetState extends State<BarcodeScannerSheet> {
  final _controller = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);
  bool _procesado = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_procesado || capture.barcodes.isEmpty) return;
    final codigo = capture.barcodes.first.rawValue;
    if (codigo == null || codigo.isEmpty) return;
    _procesado = true;
    if (widget.vibrarActivo) HapticFeedback.mediumImpact();
    Navigator.of(context).pop(codigo);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: const Text('Escanear código'),
        actions: [
          IconButton(
            icon: ValueListenableBuilder<MobileScannerState>(
              valueListenable: _controller,
              builder: (context, state, child) {
                final prendido = state.torchState == TorchState.on;
                return Icon(prendido ? Icons.flash_on : Icons.flash_off);
              },
            ),
            onPressed: () => _controller.toggleTorch(),
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error) => const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No se pudo acceder a la cámara. Revisa el permiso de cámara en los ajustes del sistema.',
                  style: TextStyle(color: Colors.white),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          ),
          Center(
            child: Container(
              width: 250,
              height: 180,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white70, width: 2),
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
          const Positioned(
            bottom: 32,
            left: 0,
            right: 0,
            child: Text(
              'Apunta la cámara al código de barras',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white),
            ),
          ),
        ],
      ),
    );
  }
}

/// Abre el escaner y retorna el codigo leido, o null si el usuario cancela.
Future<String?> mostrarEscanerCodigoBarras(BuildContext context, {bool vibrarActivo = true}) {
  return Navigator.of(context).push<String>(
    MaterialPageRoute(builder: (_) => BarcodeScannerSheet(vibrarActivo: vibrarActivo)),
  );
}
