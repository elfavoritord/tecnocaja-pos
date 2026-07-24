import 'package:flutter/material.dart';

/// FilledButton/OutlinedButton que se deshabilita y muestra spinner mientras
/// [isLoading] es true -- usado en todo formulario que dispara una operacion
/// async (login, checkout, guardar producto, etc.) para evitar doble-tap.
class LoadingButton extends StatelessWidget {
  const LoadingButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.isLoading = false,
    this.outlined = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool isLoading;
  final bool outlined;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final child = isLoading
        ? const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white),
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: 8)],
              Text(label),
            ],
          );

    final effectiveOnPressed = isLoading ? null : onPressed;

    return outlined
        ? OutlinedButton(onPressed: effectiveOnPressed, child: child)
        : FilledButton(onPressed: effectiveOnPressed, child: child);
  }
}
