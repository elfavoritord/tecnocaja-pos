import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  static final _localNotifications = FlutterLocalNotificationsPlugin();

  static const _channelId = 'delivery_channel';
  static const _channelName = 'Pedidos Delivery';

  static Future<void> init() async {
    // Canal Android
    const androidChannel = AndroidNotificationChannel(
      _channelId,
      _channelName,
      description: 'Notificaciones de pedidos de delivery',
      importance: Importance.high,
    );

    final androidImpl = _localNotifications.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    await androidImpl?.createNotificationChannel(androidChannel);

    // Inicializar plugin local
    const initSettings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      iOS: DarwinInitializationSettings(),
    );
    await _localNotifications.initialize(initSettings);

    // Solicitar permisos FCM
    await FirebaseMessaging.instance.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    // Manejar mensajes en primer plano
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
  }

  static void _handleForegroundMessage(RemoteMessage message) {
    final notification = message.notification;
    if (notification == null) return;

    _localNotifications.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          importance: Importance.high,
          priority: Priority.high,
          icon: '@mipmap/ic_launcher',
        ),
        iOS: const DarwinNotificationDetails(),
      ),
    );
  }

  static Future<String?> getToken() async {
    return FirebaseMessaging.instance.getToken();
  }
}
