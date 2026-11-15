'use strict';
const { createPosCloudConnection } = require('./pos-cloud-connection');
let connection;
function getConnection() {
  if (!connection) connection = createPosCloudConnection();
  return connection;
}
module.exports = { getConnection };
