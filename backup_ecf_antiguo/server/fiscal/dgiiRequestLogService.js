'use strict';

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function createDgiiRequestLog(queryFn, data) {
  const result = await queryFn(
    `INSERT INTO dgii_request_log
       (request_id, business_id, branch_id, cash_register_id, endpoint_type, direction,
        http_method, route_path, environment, origin_header, ip_address, content_type,
        payload_format, payload_sha256, payload_size, request_payload, request_file_path,
        response_status, response_code, response_message, response_payload, response_file_path,
        error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      data.requestId,
      data.businessId || null,
      data.branchId || null,
      data.cashRegisterId || null,
      data.endpointType,
      data.direction || 'outbound',
      data.httpMethod || null,
      data.routePath || null,
      data.environment || null,
      data.originHeader || null,
      data.ipAddress || null,
      data.contentType || null,
      data.payloadFormat || null,
      data.payloadSha256 || null,
      data.payloadSize || 0,
      data.requestPayload || null,
      data.requestFilePath || null,
      data.responseStatus || null,
      data.responseCode || null,
      data.responseMessage || null,
      data.responsePayload || null,
      data.responseFilePath || null,
      data.errorMessage || null
    ]
  );
  return Number(result?.insertId || 0) || null;
}

async function finalizeDgiiRequestLog(queryFn, logId, result) {
  if (!logId) return;
  await queryFn(
    `UPDATE dgii_request_log
     SET response_status = ?,
         response_code = ?,
         response_message = ?,
         response_payload = ?,
         response_file_path = ?,
         error_message = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      result.responseStatus || null,
      result.responseCode || null,
      result.responseMessage || null,
      result.responsePayload ? truncateText(result.responsePayload, 4000) : null,
      result.responseFilePath || null,
      result.errorMessage ? truncateText(result.errorMessage, 2000) : null,
      logId
    ]
  ).catch(() => {});
}

module.exports = {
  createDgiiRequestLog,
  finalizeDgiiRequestLog,
  truncateText
};
