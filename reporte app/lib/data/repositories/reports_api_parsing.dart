List<dynamic> reportsApiAsList(dynamic value) {
  if (value is List<dynamic>) {
    return value;
  }
  return const <dynamic>[];
}

Map<String, dynamic> reportsApiAsMap(dynamic value) {
  if (value is Map<String, dynamic>) {
    return value;
  }
  if (value is Map) {
    return value.map((key, entryValue) => MapEntry(key.toString(), entryValue));
  }
  return <String, dynamic>{};
}

double reportsApiToDouble(dynamic value) {
  if (value == null) return 0;
  if (value is num) return value.toDouble();
  return double.tryParse(value.toString()) ?? 0;
}

int reportsApiToInt(dynamic value) {
  if (value == null) return 0;
  if (value is num) return value.toInt();
  return int.tryParse(value.toString()) ?? 0;
}

String reportsApiToString(dynamic value) {
  return value?.toString() ?? '';
}

DateTime? reportsApiToDateTime(dynamic value) {
  if (value == null) return null;
  if (value is DateTime) return value;
  return DateTime.tryParse(value.toString());
}
